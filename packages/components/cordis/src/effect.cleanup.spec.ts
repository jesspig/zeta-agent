import { describe, expect, test } from "bun:test";
import { execute } from "./effect";

/** CR-33：effect 迭代中途失败时，已取得的逆动作必须被调用。 */
describe("T-33 失败路径逆回收", () => {
  test("迭代中途抛错时回收已 yield 的 disposer", async () => {
    let disposed = 0;
    const failing = (async function* () {
      yield () => { disposed += 1; };
      throw new Error("boom");
    })();
    let threw = false;
    try {
      await execute(failing, () => true);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(disposed).toBe(1);
  });
});
