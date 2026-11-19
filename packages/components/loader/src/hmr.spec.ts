import { describe, expect, test } from "bun:test";
import { runExclusive, watch, type BuildArtifact, type UnitInstance, type UnitRef } from "./hmr";

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
    expect(result).toEqual({ settled: [], aborted: [], skipped: [], retried: [] });
    watcher.close();
  });
});
