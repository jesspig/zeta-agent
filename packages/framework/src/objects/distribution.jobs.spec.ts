import { describe, expect, test } from "bun:test";
import {
  createJobRunner,
  defineDocument,
  derive,
  liveQuery,
  nativeWatch,
  openDocument,
  openStore,
} from "./index";

async function tick(ms = 5): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("T-19/jobs: 幂等队列与 worker crash 恢复", () => {
  test("同幂等键 enqueue 返回同一作业；成功后不重复执行", async () => {
    let calls = 0;
    const runner = createJobRunner({
      handler: (payload) => {
        calls += 1;
        return `done:${String(payload)}`;
      },
    });
    const first = await runner.enqueue("k1", "p");
    const second = await runner.enqueue("k1", "other-p");
    expect(second).toBe(first);
    expect(runner.pending).toBe(1);
    await runner.run();
    expect(runner.status("k1")).toBe("done");
    expect(runner.record("k1")?.result).toBe("done:p");
    expect(calls).toBe(1);
    await runner.close();
  });

  test("worker crash 把 running 退回 queued；迟到的旧执行结果被忽略，重试后完成", async () => {
    const gate = deferred();
    let calls = 0;
    const runner = createJobRunner({
      handler: async () => {
        calls += 1;
        if (calls === 1) await gate.promise;
        return "ok";
      },
    });
    await runner.enqueue("k2", null);
    const active = runner.run();
    await tick();
    expect(runner.status("k2")).toBe("running");
    runner.crash();
    expect(runner.status("k2")).toBe("queued");
    gate.resolve();
    await active;
    expect(runner.status("k2")).toBe("queued"); // 旧 attempt 的完成不得改写状态
    await runner.run();
    expect(runner.status("k2")).toBe("done");
    expect(runner.record("k2")?.attempts).toBe(2);
    expect(calls).toBe(2);
    await runner.close();
  });

  test("handler 抛错按 maxAttempts 重试后进入 failed", async () => {
    let calls = 0;
    const runner = createJobRunner({
      maxAttempts: 2,
      handler: () => {
        calls += 1;
        throw new Error("nope");
      },
    });
    await runner.enqueue("k3", null);
    await runner.run();
    await runner.run();
    expect(runner.status("k3")).toBe("failed");
    expect(calls).toBe(2);
    await runner.close();
  });
});

describe("T-19/jobs: derive / native watch / live query", () => {
  test("watch 观察提交版本；derive 随源文档重算；stop 后不再触发", async () => {
    const store = openStore();
    const def = defineDocument({ name: "cfg", initial: { n: 1 } });
    const handle = openDocument(store, def);
    const seen: Array<{ n: number }> = [];
    const stop = nativeWatch(store, handle, (doc) => seen.push({ ...(doc as { n: number }) }));
    const derived = derive(store, handle, (doc) => (doc as { n: number }).n * 2);
    expect(derived.value).toBe(2);

    await store.commit(handle.table, { n: 3 });
    await tick(20);
    expect(derived.value).toBe(6);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.at(-1)).toEqual({ n: 3 });

    stop();
    derived.stop();
    const count = seen.length;
    await store.commit(handle.table, { n: 9 });
    await tick(20);
    expect(seen.length).toBe(count);
    await store.close();
  });

  test("live query 在任一依赖变化时重算并按指纹去重通知", async () => {
    const store = openStore();
    const a = defineDocument({ name: "a", initial: { v: 1 } });
    const b = defineDocument({ name: "b", initial: { v: 2 } });
    const ha = openDocument(store, a);
    const hb = openDocument(store, b);
    const values: number[] = [];
    const query = liveQuery(
      store,
      [ha, hb],
      () => (store.read(ha.table) as { v: number }).v + (store.read(hb.table) as { v: number }).v,
      (value) => values.push(value)
    );
    expect(query.value).toBe(3);
    await store.commit(ha.table, { v: 2 });
    await tick(20);
    expect(query.value).toBe(4);
    await store.commit(hb.table, { v: 3 });
    await tick(20);
    expect(query.value).toBe(5);
    expect(values).toEqual([4, 5]);
    query.stop();
    await store.close();
  });
});
