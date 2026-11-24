import { describe, expect, test } from "bun:test";
import {
  runExclusive,
  snapshotAndBackup,
  watch,
  type BuildArtifact,
  type UnitInstance,
  type UnitRef,
  type UnitState,
} from "./hmr";

function unit(id: string): UnitRef {
  return { id, file: `${id}.ts` };
}

function builder(unitRef: UnitRef, version: number): BuildArtifact {
  return { id: `${unitRef.file}?v=${version}`, version };
}

function evaluator(artifact: BuildArtifact): UnitInstance {
  return { artifact: artifact.id, value: artifact.version };
}

function options(overrides: Partial<Parameters<typeof watch>[1]> = {}): Parameters<typeof watch>[1] {
  return {
    units: [unit("a"), unit("b"), unit("c")],
    build: builder,
    evaluate: evaluator,
    apply: () => undefined,
    ...overrides,
  };
}

describe("HMR 按 unit 部分提交", () => {
  test("版本戳构建产物 + 全新求值，不依赖 Bun 的 ESM 缓存驱逐", async () => {
    const instances: UnitInstance[] = [];
    const watcher = watch(
      "/plugins",
      options({
        units: [unit("a")],
        evaluate: (artifact) => {
          const instance = { artifact: artifact.id, value: artifact.version };
          instances.push(instance);
          return instance;
        },
      })
    );
    expect(watcher.strategy).toBe("artifact-version-fresh-eval");

    watcher.markDirty(["a.ts"]);
    await watcher.flush();
    const first = watcher.stateOf("a")!;
    expect(first.version).toBe(1);
    expect(first.artifact.id).toBe("a.ts?v=1");

    watcher.markDirty(["a.ts"]);
    await watcher.flush();
    const second = watcher.stateOf("a")!;
    expect(second.version).toBe(2);
    expect(second.artifact.id).toBe("a.ts?v=2");
    expect(second.instance).not.toBe(first.instance);
    expect(instances).toHaveLength(2);
    watcher.close();
  });

  test("build 故障注入按 unit abort，从 backup 恢复且只影响目标 unit", async () => {
    let cBuilds = 0;
    const watcher = watch(
      "/plugins",
      options({
        build: (unitRef, version) => {
          if (unitRef.id === "c" && ++cBuilds === 2) throw new Error("build boom");
          return builder(unitRef, version);
        },
      })
    );

    watcher.markDirty(["a.ts", "b.ts", "c.ts"]);
    await watcher.flush();
    const beforeC = watcher.stateOf("c")!;
    const beforeB = watcher.stateOf("b")!;

    watcher.markDirty(["a.ts", "c.ts"]);
    const result = await watcher.flush();
    expect(result.settled).toEqual(["a"]);
    expect(result.aborted).toEqual(["c"]);
    expect(watcher.stateOf("c")).toBe(beforeC);
    expect(watcher.stateOf("c")!.version).toBe(1);
    expect(watcher.stateOf("b")).toBe(beforeB);
    expect(watcher.stateOf("b")!.version).toBe(1);
    expect(watcher.stateOf("a")!.version).toBe(2);
    watcher.close();
  });

  test("跳过的 unit 只恢复自身，其余 unit 正常提交", async () => {
    let skipC = false;
    const watcher = watch(
      "/plugins",
      options({
        classify: (unitRef) => (skipC && unitRef.id === "c" ? "host-module" : undefined),
      })
    );
    watcher.markDirty(["a.ts", "b.ts", "c.ts"]);
    await watcher.flush();
    const beforeC = watcher.stateOf("c")!;
    expect(beforeC.version).toBe(1);

    skipC = true;
    watcher.markDirty(["a.ts", "c.ts"]);
    const result = await watcher.flush();
    expect(result.settled).toEqual(["a"]);
    expect(result.skipped).toEqual(["c"]);
    expect(watcher.stateOf("c")).toBe(beforeC);
    expect(watcher.stateOf("b")!.version).toBe(1);
    watcher.close();
  });

  test("apply 失败留 FAILED 不回滚，下次文件变更才重试", async () => {
    let failApply = true;
    const watcher = watch(
      "/plugins",
      options({
        units: [unit("a")],
        apply: () => {
          if (failApply) throw new Error("apply boom");
        },
      })
    );

    watcher.markDirty(["a.ts"]);
    const failed = await watcher.flush();
    expect(failed.settled).toEqual([]);
    expect(failed.detail.settled).toEqual([]); // apply 失败不进 settled 明细
    expect(watcher.failed()).toEqual(["a"]);
    const failedState = watcher.stateOf("a")!;
    expect(failedState.status).toBe("FAILED");
    expect(failedState.version).toBe(1);

    const idle = await watcher.flush();
    expect(idle.settled).toEqual([]);
    expect(idle.aborted).toEqual([]);
    expect(watcher.failed()).toEqual(["a"]);

    failApply = false;
    watcher.markDirty(["a.ts"]);
    const retried = await watcher.flush();
    expect(retried.settled).toEqual(["a"]);
    expect(retried.retried).toEqual(["a"]);
    expect(retried.detail.settled).toEqual([{ id: "a" }]);
    expect(watcher.failed()).toEqual([]);
    expect(watcher.stateOf("a")!.status).toBe("ACTIVE");
    expect(watcher.stateOf("a")!.version).toBe(2);
    watcher.close();
  });

  test("runExclusive 单队列串行执行，拒绝嵌套调用", async () => {
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

  test("无脏文件时 flush 为空操作", async () => {
    const watcher = watch("/plugins", options());
    const result = await watcher.flush();
    expect(result).toEqual({
      settled: [],
      aborted: [],
      skipped: [],
      retried: [],
      detail: { settled: [], aborted: [], skipped: [] },
    });
    watcher.close();
  });
});

/**
 * T-06 HMR unit 快照恢复（cordis 语义补齐）。
 *
 * 简化偏离声明：cordis 把变更按"共享驱逐模块的连通单元"分区（_partition），
 * 这里 unit = FiberId 独立分组；Node 内部 API（--expose-internals / loadCache /
 * require.cache / restoreResolutions）在 Bun 不可达，快照只作用于 hmr.ts 自身
 * 的 states / instance 引用，模块隔离靠 data URL 内容寻址 + Fiber.reload 复用 identity。
 */
describe("T-06 HMR unit 快照恢复", () => {
  function stateFor(id: string, version: number): UnitState {
    return {
      unit: unit(id),
      version,
      artifact: { id: `${id}.ts?v=${version}`, version },
      instance: { artifact: `${id}.ts?v=${version}`, value: version },
      status: "ACTIVE",
    };
  }

  test("snapshotAndBackup 捕获旧实例与 committed 引用，restore 按 id 恢复同一对象", () => {
    const states = new Map<string, UnitState>();
    const oldA = stateFor("a", 1);
    states.set("a", oldA);

    const { snapshot, backup } = snapshotAndBackup([unit("a"), unit("b")], states);
    const snapA = snapshot.units.get("a")!;
    expect(snapA.id).toBe("a");
    expect(snapA.instance).toBe(oldA.instance);
    expect(snapA.committed).toBe(oldA);
    expect(snapA.version).toBe(2);
    // 无旧状态的 unit 也能建立快照，版本从 1 起。
    expect(snapshot.units.get("b")!.committed).toBeUndefined();
    expect(snapshot.units.get("b")!.instance).toBeUndefined();
    expect(snapshot.units.get("b")!.version).toBe(1);

    // 模拟事务中状态被改写；restore 只恢复传入的 ids（按 unit 部分恢复）。
    states.set("a", { ...oldA, version: 2, status: "FAILED" });
    states.set("b", stateFor("b", 1));
    backup.restore(["a"]);
    expect(states.get("a")).toBe(oldA); // committed 引用 === 旧
    expect(states.get("a")!.instance).toBe(oldA.instance); // 旧导出引用 === 旧
    expect(states.has("b")).toBe(true); // b 不在恢复列表，保持被改写状态

    backup.restore(["b"]);
    expect(states.has("b")).toBe(false); // 无旧状态时恢复为删除
  });

  test("evaluate 故障按 unit abort：旧实例引用保留、其他 unit 部分提交、detail 带 error", async () => {
    let failB = false;
    const watcher = watch(
      "/plugins",
      options({
        evaluate: (artifact) => {
          if (artifact.id.startsWith("b.ts") && failB) throw new Error("evaluate boom");
          return evaluator(artifact);
        },
      })
    );

    watcher.markDirty(["a.ts", "b.ts", "c.ts"]);
    await watcher.flush();
    const beforeB = watcher.stateOf("b")!;

    failB = true;
    watcher.markDirty(["a.ts", "b.ts", "c.ts"]);
    const result = await watcher.flush();
    // 部分提交：a/c 成功，b abort。
    expect(result.settled).toEqual(["a", "c"]);
    expect(result.aborted).toEqual(["b"]);
    // 快照显式恢复：stateOf(b) 与旧导出实例引用都严格等于旧对象。
    expect(watcher.stateOf("b")).toBe(beforeB);
    expect(watcher.stateOf("b")!.instance).toBe(beforeB.instance);
    expect(watcher.stateOf("a")!.version).toBe(2);
    expect(watcher.stateOf("c")!.version).toBe(2);
    // detail 结构化信息不破坏 string[]。
    expect(result.detail.settled.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(result.detail.aborted).toHaveLength(1);
    expect(result.detail.aborted[0]!.id).toBe("b");
    expect(String(result.detail.aborted[0]!.error)).toContain("evaluate boom");
    watcher.close();
  });

  test("skip 不写 state 且 detail 带 SkipReason", async () => {
    const watcher = watch(
      "/plugins",
      options({
        classify: (unitRef) => (unitRef.id === "c" ? "native-addon" : undefined),
      })
    );
    watcher.markDirty(["a.ts", "b.ts", "c.ts"]);
    const result = await watcher.flush();
    expect(result.settled).toEqual(["a", "b"]);
    expect(result.skipped).toEqual(["c"]);
    expect(watcher.stateOf("c")).toBeUndefined(); // skip 不写 state
    expect(watcher.failed()).toEqual([]); // skip 不需重启以外重试
    expect(result.detail.skipped).toEqual([{ id: "c", reason: "native-addon" }]);
    watcher.close();
  });

  test("aborted 单元加入 retained，下次文件变更自动重试（cordis retained 语义）", async () => {
    let failA = true;
    const watcher = watch(
      "/plugins",
      options({
        build: (unitRef, version) => {
          if (unitRef.id === "a" && failA) throw new Error("build boom");
          return builder(unitRef, version);
        },
      })
    );

    watcher.markDirty(["a.ts", "b.ts"]);
    const first = await watcher.flush();
    expect(first.aborted).toEqual(["a"]);
    expect(first.settled).toEqual(["b"]);
    expect(watcher.failed()).toEqual(["a"]); // aborted 进入 failedUnits = retained

    // a 的文件未再变更，仅 b.ts 变更：a 因 retained 自动重试并提交。
    failA = false;
    watcher.markDirty(["b.ts"]);
    const second = await watcher.flush();
    expect(second.settled).toContain("a");
    expect(second.retried).toContain("a");
    expect(second.aborted).toEqual([]);
    expect(watcher.failed()).toEqual([]);
    expect(watcher.stateOf("a")!.version).toBe(1);
    watcher.close();
  });

  test("部分提交宿主隔离：aborted/skipped 单元状态引用不变，宿主旧导出不被破坏", async () => {
    let failC = false;
    let skipB = false;
    const watcher = watch(
      "/plugins",
      options({
        build: (unitRef, version) => {
          if (unitRef.id === "c" && failC) throw new Error("build boom");
          return builder(unitRef, version);
        },
        classify: (unitRef) => (skipB && unitRef.id === "b" ? "host-module" : undefined),
      })
    );

    watcher.markDirty(["a.ts", "b.ts", "c.ts"]);
    await watcher.flush();
    const beforeA = watcher.stateOf("a")!;
    const beforeB = watcher.stateOf("b")!;
    const beforeC = watcher.stateOf("c")!;

    failC = true;
    skipB = true;
    watcher.markDirty(["a.ts", "b.ts", "c.ts"]);
    const result = await watcher.flush();
    expect(result.settled).toEqual(["a"]);
    expect(result.aborted).toEqual(["c"]);
    expect(result.skipped).toEqual(["b"]);
    // aborted / skipped 单元的旧状态与旧导出实例引用均保持不变。
    expect(watcher.stateOf("b")).toBe(beforeB);
    expect(watcher.stateOf("b")!.instance).toBe(beforeB.instance);
    expect(watcher.stateOf("c")).toBe(beforeC);
    expect(watcher.stateOf("c")!.instance).toBe(beforeC.instance);
    // 其余单元正常提交，宿主隔离成立。
    expect(watcher.stateOf("a")).not.toBe(beforeA);
    expect(watcher.stateOf("a")!.version).toBe(2);
    watcher.close();
  });
});
