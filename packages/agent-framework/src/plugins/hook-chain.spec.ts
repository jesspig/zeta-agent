import { describe, expect, test } from "bun:test";
import { HookChain } from "./hook-chain";

describe("T-07 HookChain 拓扑排序与失败分层", () => {
  test("priority 升序、同值按注册序；dependsOn 参与拓扑排序", async () => {
    const chain = new HookChain<string>({ name: "prepareRequest" });
    chain.add((input) => `${input}-c`, 1, "c", { dependsOn: ["a", "b"] });
    chain.add((input) => `${input}-b`, 200, "b");
    chain.add((input) => `${input}-a`, 100, "a");
    expect(chain.names).toEqual(["a", "b", "c"]);
    expect(await chain.run("x")).toBe("x-a-b-c");
  });

  test("环只让环内 hook FAILED，链上其他 hook 仍执行", async () => {
    const chain = new HookChain<string>({ name: "wrap" });
    chain.add((input) => `${input}-a`, 1, "a", { dependsOn: ["b"] });
    chain.add((input) => `${input}-b`, 2, "b", { dependsOn: ["a"] });
    chain.add((input) => `${input}-safe`, 3, "safe");

    expect(chain.cycles).toHaveLength(1);
    expect(chain.failedEntries.map((entry) => entry.name).sort()).toEqual(["a", "b"]);
    expect(chain.failedEntries.every((entry) => entry.status === "FAILED" && entry.failureReason === "HOOK_CYCLE")).toBe(true);
    expect(chain.names).toEqual(["safe"]);
    expect(await chain.run("x")).toBe("x-safe");
  });

  test("普通 hook no-throw：归一化、记录、后续 hook 继续执行", async () => {
    const seen: string[] = [];
    const errors: string[] = [];
    const chain = new HookChain<string>({
      name: "turnBoundary",
      onError: (failure) => errors.push(failure.error.message),
    });
    chain.add(() => { throw "boom-as-string"; }, 1, "broken");
    chain.add((input) => { seen.push("after"); return `${input}-ok`; }, 2, "healthy");

    expect(await chain.run("x")).toBe("x-ok");
    expect(seen).toEqual(["after"]);
    expect(errors).toEqual(["boom-as-string"]);
    expect(chain.lastFailures[0]?.error).toBeInstanceOf(Error);

    const strict = new HookChain<string>({ rethrow: true });
    strict.add(() => { throw new Error("fatal"); }, 1);
    await expect(strict.run("x")).rejects.toThrow("fatal");
  });

  test("runEach 通过链逐项发射，单项抛错不阻断后续条目", async () => {
    const chain = new HookChain<string>({ name: "converter" });
    chain.add(() => { throw new Error("bad-converter"); }, 1, "bad");
    chain.add((input) => `${input}-event`, 2, "good");
    const received: string[] = [];
    await chain.runEach("raw", undefined, (value) => {
      if (typeof value === "string") received.push(value);
    });
    expect(received).toEqual(["raw-event"]);
    expect(chain.lastFailures[0]?.name).toBe("bad");
  });

  test("disposer 幂等，disposeAll 按 LIFO 撤销", () => {
    const chain = new HookChain<string>();
    const order: string[] = [];
    chain.add(() => { order.push("a"); }, 1, "a");
    const stopB = chain.add(() => { order.push("b"); }, 2, "b");
    chain.add(() => { order.push("c"); }, 3, "c");
    stopB();
    stopB();
    expect(chain.names).toEqual(["a", "c"]);
    chain.disposeAll();
    expect(chain.size).toBe(0);
    expect(order).toEqual([]);
  });
});
