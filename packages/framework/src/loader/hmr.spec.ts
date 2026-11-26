import { describe, expect, test } from "bun:test";
import { defineComponent } from "../context";
import { createComponentRegistry } from "./registry";
import {
  analyzeGraph,
  buildImportGraph,
  closureDigest,
  createHmrController,
  detectCycles,
  digestText,
  parseImports,
  runExclusive,
  signFile,
  type BuildArtifact,
  type HmrUnit,
  type UnitInstance,
} from "./hmr";

const unit = (id: string, entry: string): HmrUnit => ({ id, entry });

function files(record: Record<string, string>): (path: string) => string | undefined {
  return (path) => record[path];
}

function artifact(id: string, digest: string, version: number): BuildArtifact {
  return { id, digest, version };
}

function instance(artifact: BuildArtifact, value: unknown): UnitInstance {
  return { artifact: artifact.id, value };
}

describe("T-15 输入闭包 digest", () => {
  test("digestText 对内容敏感且稳定", () => {
    expect(digestText("abc")).toBe(digestText("abc"));
    expect(digestText("abc")).not.toBe(digestText("abd"));
    expect(digestText("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("signFile 签名内容，验证可检测篡改", () => {
    const signature = signFile("a.ts", files({ "a.ts": "v1" }));
    expect(signature.path).toBe("a.ts");
    expect(signature.digest).toBe(digestText("v1"));
    expect(signature.digest).not.toBe(digestText("v2"));
  });

  test("parseImports 解析静态 import / export-from 并解析相对路径", () => {
    const source = [
      'import a from "./a";',
      'import { b } from "../shared/b.ts";',
      'export { c } from "./c";',
      'const d = "not an import";',
    ].join("\n");
    const parsed = parseImports(source, "plugins/entry.ts");
    expect(parsed).toContain("plugins/a");
    expect(parsed).toContain("shared/b.ts");
    expect(parsed).toContain("plugins/c");
    expect(parsed).not.toContain("not an import");
  });

  test("buildImportGraph 收集传递闭包，closureDigest 只随闭包内容变化", () => {
    const read = files({
      "a.ts": 'import "./shared.ts";',
      "shared.ts": "shared-v1",
      "b.ts": "b-v1",
    });
    const graph = buildImportGraph(["a.ts", "b.ts"], read);
    expect(graph.edges["a.ts"]).toContain("shared.ts");

    const signatures = new Map<string, string>([
      ["a.ts", digestText('import "./shared.ts";')],
      ["shared.ts", digestText("shared-v1")],
      ["b.ts", digestText("b-v1")],
    ]);
    const before = closureDigest(graph, "a.ts", signatures);
    expect(before).toBe(closureDigest(graph, "a.ts", signatures));
    signatures.set("shared.ts", digestText("shared-v2"));
    expect(closureDigest(graph, "a.ts", signatures)).not.toBe(before);
    // b 的闭包不含 shared，digest 不受影响。
    const beforeB = closureDigest(graph, "b.ts", signatures);
    signatures.set("a.ts", digestText("a-changed"));
    expect(closureDigest(graph, "b.ts", signatures)).toBe(beforeB);
  });
});

describe("T-15 import graph accepted/declined 不动点与连通 unit", () => {
  test("共享依赖变更让两个 unit 落入同一连通分区", () => {
    const graph = buildImportGraph(
      ["a.ts", "b.ts"],
      files({
        "a.ts": 'import "./shared.ts";',
        "b.ts": 'import "./shared.ts";',
        "shared.ts": "shared-v1",
      })
    );
    const analysis = analyzeGraph(graph, ["shared.ts"], ["a.ts", "b.ts"], ["a.ts", "b.ts"]);
    expect(analysis.declined).toContain("shared.ts");
    const partition = analysis.partitions.find((group) => group.length === 2);
    expect(partition?.slice().sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("accept 边界吸收变更，不动点停止传播", () => {
    const graph = buildImportGraph(
      ["entry.ts"],
      files({
        "entry.ts": 'import "./dep.ts";',
        "dep.ts": 'import "./leaf.ts";',
        "leaf.ts": "leaf-v1",
      })
    );
    const analysis = analyzeGraph(graph, ["leaf.ts"], ["entry.ts"], ["entry.ts"]);
    expect(analysis.accepted).toContain("entry.ts");
    expect(analysis.declined).not.toContain("entry.ts");
    expect(analysis.partitions.flat()).toEqual(["entry.ts"]);
  });
});

describe("T-15 runExclusive 与 readiness barrier", () => {
  test("单队列串行，嵌套调用拒绝", async () => {
    const order: string[] = [];
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
    const first = runExclusive(async () => {
      order.push("a-start");
      await pause();
      order.push("a-end");
    });
    const second = runExclusive(async () => {
      order.push("b-start");
      await pause();
      order.push("b-end");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    await expect(runExclusive(() => runExclusive(() => 1))).rejects.toThrow("HMR_NESTED");
  });
});

describe("T-15 HMR 事务语义", () => {
  function controller(overrides: {
    units?: readonly HmrUnit[];
    files?: Record<string, string>;
    build?: (unit: HmrUnit, version: number, digest: string) => BuildArtifact;
    evaluate?: (artifact: BuildArtifact) => UnitInstance;
    apply?: (unit: HmrUnit, instance: UnitInstance) => void;
    critical?: readonly string[];
    compensate?: (unit: HmrUnit) => void;
  } = {}) {
    const record: Record<string, string> = {
      "a.ts": "a-v1",
      "b.ts": "b-v1",
      ...(overrides.files ?? {}),
    };
    let evaluations = 0;
    const applyCalls: string[] = [];
    const ctrl = createHmrController({
      root: "/plugins",
      units: overrides.units ?? [unit("a", "a.ts"), unit("b", "b.ts")],
      readFile: files(record),
      build: (item, version, digest) =>
        overrides.build?.(item, version, digest) ?? artifact(`${item.entry}?v=${version}`, digest, version),
      evaluate: (item) => {
        evaluations += 1;
        return overrides.evaluate?.(item) ?? instance(item, item.version);
      },
      apply: (item, value) => {
        applyCalls.push(item.id);
        overrides.apply?.(item, value);
      },
      critical: overrides.critical,
      compensate: (item) => overrides.compensate?.(item),
    });
    return { ctrl, record, get evaluations() { return evaluations; }, applyCalls };
  }

  test("首次变更仅目标 unit 求值；未变 digest 不求值", async () => {
    const harness = controller();
    const { ctrl } = harness;
    ctrl.markDirty(["a.ts"]);
    const first = await ctrl.flush();
    expect(first.settled).toEqual(["a"]);
    expect(harness.evaluations).toBe(1);

    // 再来一次相同内容：可重新落脏，但 digest 未变，直接复用。
    ctrl.markDirty(["a.ts"]);
    const second = await ctrl.flush();
    expect(second.reused).toEqual(["a"]);
    expect(second.settled).toEqual([]);
    expect(harness.evaluations).toBe(1);
    ctrl.close();
  });

  test("build/evaluate 失败恢复旧 artifact，其他 unit 状态保留", async () => {
    let failA = false;
    const { ctrl, record } = controller({
      build: (item, version, digest) => {
        if (item.id === "a" && failA) throw new Error("BUILD_BOOM");
        return artifact(`${item.entry}?v=${version}`, digest, version);
      },
    });
    ctrl.markDirty(["a.ts", "b.ts"]);
    await ctrl.flush();
    const beforeA = ctrl.stateOf("a")!;

    record["a.ts"] = "a-v2";
    failA = true;
    ctrl.markDirty(["a.ts", "b.ts"]);
    const result = await ctrl.flush();
    expect(result.aborted).toEqual(["a"]);
    // b 内容未变，按 digest 复用，不求值、不改写状态。
    expect(result.reused).toEqual(["b"]);
    expect(ctrl.stateOf("a")).toBe(beforeA);
    expect(ctrl.stateOf("a")!.artifact).toBe(beforeA.artifact);
    expect(ctrl.failed()).toEqual(["a"]);
    ctrl.close();
  });

  test("apply 失败留 FAILED，下次文件变更才重试", async () => {
    let failApply = true;
    const { ctrl } = controller({
      apply: () => {
        if (failApply) throw new Error("APPLY_BOOM");
      },
    });
    ctrl.markDirty(["a.ts"]);
    const first = await ctrl.flush();
    expect(first.settled).toEqual([]);
    expect(ctrl.stateOf("a")!.status).toBe("FAILED");
    expect(ctrl.failed()).toEqual(["a"]);

    await ctrl.flush();
    expect(ctrl.failed()).toEqual(["a"]);

    failApply = false;
    ctrl.markDirty(["a.ts"]);
    const retried = await ctrl.flush();
    expect(retried.retried).toEqual(["a"]);
    expect(ctrl.stateOf("a")!.status).toBe("ACTIVE");
    ctrl.close();
  });

  test("同 fiber replace/revision：revision 递增，保留 parent/config 与其他 unit", async () => {
    const seen: string[] = [];
    const harness = controller({
      apply: (item) => {
        seen.push(item.id);
      },
    });
    const { ctrl, record } = harness;
    ctrl.markDirty(["a.ts", "b.ts"]);
    await ctrl.flush();
    expect(seen).toEqual(["a", "b"]);
    expect(ctrl.revisionOf("a")).toBe(1);
    expect(ctrl.revisionOf("b")).toBe(1);

    record["a.ts"] = "a-v2";
    ctrl.markDirty(["a.ts"]);
    await ctrl.flush();
    expect(seen.at(-1)).toBe("a");
    expect(ctrl.revisionOf("a")).toBe(2);
    expect(ctrl.revisionOf("b")).toBe(1);
    ctrl.close();
  });

  test("文件签名不匹配时 abort 并保留旧状态", async () => {
    const { ctrl } = controller();
    ctrl.markDirty(["a.ts"]);
    await ctrl.flush();
    const before = ctrl.stateOf("a")!;

    ctrl.markDirtySigned([{ path: "a.ts", digest: digestText("tampered") }]);
    const tampered = await ctrl.flush();
    expect(tampered.aborted).toContain("a");
    expect(ctrl.stateOf("a")).toBe(before);
    ctrl.close();
  });

  test("critical root apply 失败触发 shadow-apply/compensation", async () => {
    let failApply = true;
    let compensated = 0;
    const { ctrl } = controller({
      units: [unit("a", "a.ts")],
      critical: ["a"],
      compensate: () => {
        compensated += 1;
      },
      apply: () => {
        if (failApply) throw new Error("SHADOW_BOOM");
      },
    });
    ctrl.markDirty(["a.ts"]);
    const failed = await ctrl.flush();
    expect(failed.settled).toEqual([]);
    expect(compensated).toBe(1);
    expect(ctrl.stateOf("a")!.status).toBe("FAILED");

    failApply = false;
    ctrl.markDirty(["a.ts"]);
    const ok = await ctrl.flush();
    expect(ok.settled).toEqual(["a"]);
    expect(compensated).toBe(1);
    ctrl.close();
  });

  test("ready() 作为 readiness barrier 等待在途事务", async () => {
    const { ctrl } = controller();
    ctrl.markDirty(["a.ts"]);
    const flush = ctrl.flush();
    await ctrl.ready();
    expect(ctrl.stateOf("a")).toBeDefined();
    await flush;
    ctrl.close();
  });
});

describe("T-05 HMR 动态图与连通 unit 提交", () => {
  function harness(record: Record<string, string>, overrides: {
    build?: (unit: HmrUnit, version: number, digest: string) => BuildArtifact;
    apply?: (unit: HmrUnit, instance: UnitInstance) => void;
    readFile?: (path: string) => string | Uint8Array | undefined;
    debounceMs?: number;
    onError?: (error: unknown) => void;
    auto?: boolean;
  } = {}) {
    const ctrl = createHmrController({
      root: "/plugins",
      units: [unit("a", "a.ts"), unit("b", "b.ts")],
      readFile: overrides.readFile ?? files(record),
      build: (item, version, digest) =>
        overrides.build?.(item, version, digest) ?? artifact(`${item.entry}?v=${version}`, digest, version),
      evaluate: (item) => instance(item, item.version),
      apply: (item, value) => overrides.apply?.(item, value),
      debounceMs: overrides.debounceMs,
      onError: overrides.onError,
      auto: overrides.auto,
    });
    return ctrl;
  }

  test("每次事务重建 import graph：新增/删除 import 与环都可检测", async () => {
    const record: Record<string, string> = {
      "a.ts": 'import "./shared.ts";',
      "b.ts": "b-v1",
      "shared.ts": "shared-v1",
    };
    const ctrl = harness(record);
    expect(ctrl.graph().edges["a.ts"]).toContain("shared.ts");
    expect(ctrl.analysis().cycles).toEqual([]);

    record["a.ts"] = "a-v2";
    ctrl.markDirty(["a.ts"]);
    await ctrl.flush();
    expect(ctrl.graph().edges["a.ts"] ?? []).toEqual([]);

    record["a.ts"] = 'import "./b.ts";';
    record["b.ts"] = 'import "./a.ts";';
    ctrl.markDirty(["a.ts", "b.ts"]);
    await ctrl.flush();
    expect(ctrl.graph().edges["a.ts"]).toContain("b.ts");
    expect(ctrl.graph().edges["b.ts"]).toContain("a.ts");
    expect(detectCycles(ctrl.graph()).length).toBeGreaterThan(0);
    expect(ctrl.analysis().cycles.length).toBeGreaterThan(0);
    ctrl.close();
  });

  test("共享依赖失败时整个连通 unit 回退，保留旧 artifact", async () => {
    const record: Record<string, string> = {
      "a.ts": 'import "./shared.ts";',
      "b.ts": 'import "./shared.ts";',
      "shared.ts": "shared-v1",
    };
    let failB = false;
    const ctrl = harness(record, {
      build: (item, version, digest) => {
        if (item.id === "b" && failB) throw new Error("SHARED_BOOM");
        return artifact(`${item.entry}?v=${version}`, digest, version);
      },
    });
    ctrl.markDirty(["shared.ts"]);
    const first = await ctrl.flush();
    expect(first.settled).toEqual(["a", "b"]);
    const beforeA = ctrl.stateOf("a")!;
    const beforeB = ctrl.stateOf("b")!;

    record["shared.ts"] = "shared-v2";
    failB = true;
    ctrl.markDirty(["shared.ts"]);
    const result = await ctrl.flush();
    expect(result.aborted).toContain("a");
    expect(result.aborted).toContain("b");
    expect(result.settled).toEqual([]);
    expect(ctrl.stateOf("a")).toBe(beforeA);
    expect(ctrl.stateOf("b")).toBe(beforeB);
    ctrl.close();
  });

  test("registry.replace 真实保留 uid/parent/config 并递增 revision", async () => {
    const registry = createComponentRegistry();
    const oldComponent = defineComponent({ name: "old", inject: [], provide: [], apply: () => () => {} });
    const replacement = defineComponent({ name: "new", inject: [], provide: [], apply: () => () => {} });
    const config = { port: 1 };
    const original = registry.register(oldComponent, { uid: "stable", parent: "root", config });
    const ctrl = createHmrController({
      root: "/plugins",
      units: [unit("a", "a.ts")],
      readFile: files({ "a.ts": "v1" }),
      build: (item, version, digest) => artifact(`${item.entry}?v=${version}`, digest, version),
      evaluate: (item) => instance(item, item.version),
      apply: () => undefined,
      registry,
      componentOf: () => oldComponent,
      replacementOf: () => replacement,
    });
    ctrl.markDirty(["a.ts"]);
    const result = await ctrl.flush();
    expect(result.settled).toEqual(["a"]);
    const replaced = registry.byUid("stable")!;
    expect(replaced).not.toBe(original);
    expect(replaced.uid).toBe("stable");
    expect(replaced.parent).toBe("root");
    expect(replaced.config).toBe(config);
    expect(replaced.component).toBe(replacement);
    expect(replaced.revision).toBe(1);
    ctrl.close();
  });

  test("apply 失败后重试只与变更 roots 相关", async () => {
    let failApply = true;
    const ctrl = harness({ "a.ts": "a-v1", "b.ts": "b-v1" }, {
      apply: (item) => {
        if (item.id === "a" && failApply) throw new Error("APPLY_BOOM");
      },
    });
    ctrl.markDirty(["a.ts"]);
    const failed = await ctrl.flush();
    expect(failed.settled).toEqual([]);
    expect(ctrl.stateOf("a")?.status).toBe("FAILED");

    ctrl.markDirty(["b.ts"]);
    const unrelated = await ctrl.flush();
    expect(unrelated.retried).not.toContain("a");
    expect(ctrl.stateOf("a")?.status).toBe("FAILED");

    failApply = false;
    ctrl.markDirty(["a.ts"]);
    const retried = await ctrl.flush();
    expect(retried.retried).toContain("a");
    expect(retried.settled).toContain("a");
    expect(ctrl.stateOf("a")?.status).toBe("ACTIVE");
    ctrl.close();
  });

  test("事务队列按实例隔离，auto watcher 的 flush 拒绝有错误出口", async () => {
    const record: Record<string, string> = { "a.ts": "v1", "b.ts": "v1" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const a = createHmrController({
      root: "/p",
      units: [unit("a", "a.ts")],
      readFile: files(record),
      build: (item, version, digest) => artifact(`${item.entry}?v=${version}`, digest, version),
      evaluate: (item) => instance(item, item.version),
      apply: async () => {
        order.push("a-apply");
        await gate;
      },
    });
    const b = createHmrController({
      root: "/p",
      units: [unit("b", "b.ts")],
      readFile: files(record),
      build: (item, version, digest) => artifact(`${item.entry}?v=${version}`, digest, version),
      evaluate: (item) => instance(item, item.version),
      apply: () => {
        order.push("b-apply");
      },
    });
    a.markDirty(["a.ts"]);
    b.markDirty(["b.ts"]);
    const pendingA = a.flush();
    const pendingB = b.flush();
    await b.ready();
    expect(order).toContain("b-apply");
    release();
    await Promise.all([pendingA, pendingB]);
    a.close();
    b.close();

    let armed = false;
    const errors: unknown[] = [];
    const watched = createHmrController({
      root: "/p",
      units: [unit("a", "a.ts")],
      readFile: (path) => {
        if (armed) throw new Error("READ_BOOM");
        return record[path];
      },
      build: (item, version, digest) => artifact(`${item.entry}?v=${version}`, digest, version),
      evaluate: (item) => instance(item, item.version),
      apply: () => undefined,
      debounceMs: 0,
      onError: (error) => errors.push(error),
    });
    armed = true;
    watched.notifyFile("a.ts");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watched.ready();
    expect(watched.errors().length).toBeGreaterThan(0);
    expect(errors.length).toBeGreaterThan(0);
    watched.close();
  });
});

describe("T-10 HMR unit 隔离与 close 生命周期", () => {
  test("独立 unit 不互相重启：只有落脏目标被 build/evaluate/apply", async () => {
    let evaluations = 0;
    const applied: string[] = [];
    const record: Record<string, string> = { "a.ts": "a-v1", "b.ts": "b-v1" };
    const ctrl = createHmrController({
      root: "/p",
      units: [unit("a", "a.ts"), unit("b", "b.ts")],
      readFile: files(record),
      build: (item, version, digest) => artifact(`${item.entry}?v=${version}`, digest, version),
      evaluate: (item) => {
        evaluations += 1;
        return instance(item, item.version);
      },
      apply: (item) => {
        applied.push(item.id);
      },
    });
    ctrl.markDirty(["a.ts"]);
    await ctrl.flush();
    expect(evaluations).toBe(1);
    expect(applied).toEqual(["a"]);

    record["a.ts"] = "a-v2";
    ctrl.markDirty(["a.ts"]);
    await ctrl.flush();
    expect(evaluations).toBe(2);
    expect(applied).toEqual(["a", "a"]);
    expect(ctrl.revisionOf("b")).toBe(0);
    ctrl.close();
  });

  test("close 后不再登记/启动事务，ready 仍能等待在途事务", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const record: Record<string, string> = { "a.ts": "a-v1" };
    const ctrl = createHmrController({
      root: "/p",
      units: [unit("a", "a.ts")],
      readFile: files(record),
      build: (item, version, digest) => artifact(`${item.entry}?v=${version}`, digest, version),
      evaluate: (item) => instance(item, item.version),
      apply: async () => { await gate; },
    });
    ctrl.markDirty(["a.ts"]);
    const pending = ctrl.flush();
    ctrl.close();
    expect(ctrl.closed).toBe(true);
    ctrl.notifyFile("a.ts");
    ctrl.markDirty(["a.ts"]);
    await expect(ctrl.flush()).rejects.toThrow("HMR_CLOSED");
    release();
    await pending;
    await ctrl.ready();
    expect(ctrl.stateOf("a")?.status).toBe("ACTIVE");
  });
});
