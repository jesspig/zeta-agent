import { describe, expect, test } from "bun:test";
import { createCredentialVault } from "./vault";

/** CR-35：占位符解析必须确认签发实例归属。 */
describe("T-35 凭据占位符归属", () => {
  test("另一个 vault 签发的占位符不能被解析", () => {
    const binding = { scheme: "https", host: "api.test" };
    const a = createCredentialVault();
    const b = createCredentialVault();
    const phA = a.issue({ name: "k", binding });
    const phB = b.issue({ name: "k", binding: { scheme: "https", host: "evil.test" } });
    expect(a.bindingOf(phA)).toEqual(binding);
    // 两个 vault 都签发过，token 若只是序号则会碰撞并被错误解析
    expect(b.bindingOf(phA)).toBeUndefined();
    expect(a.bindingOf(phB)).toBeUndefined();
  });
});
