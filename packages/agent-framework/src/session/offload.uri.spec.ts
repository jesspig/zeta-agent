import { describe, expect, test } from "bun:test";
import { createMemoryWorkspaceStore, createOffloader } from "./offload";

/** CR-20：不同 offloader 共享 store 时 URI 必须唯一，旧引用不被覆盖。 */
describe("T-19 外置 URI 跨实例唯一", () => {
  test("两个实例使用共享 store 生成不同 URI", async () => {
    const store = createMemoryWorkspaceStore();
    const a = createOffloader(store);
    const b = createOffloader(store);
    const uriA = await a.offload({ v: "a" }, "block");
    const uriB = await b.offload({ v: "b" }, "block");
    expect(uriA).not.toBe(uriB);
    expect(await a.retrieve(uriA)).toEqual({ v: "a" });
    expect(await b.retrieve(uriB)).toEqual({ v: "b" });
  });
});
