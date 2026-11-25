import { expect, test } from "bun:test";
import { evidenceFileName } from "./gate-lib.mjs";

test("证据文件名使用跨平台安全字符", () => {
  expect(evidenceFileName("security:audit")).toBe("security-audit.txt");
  expect(evidenceFileName("tests:unit")).toBe("tests-unit.txt");
  expect(evidenceFileName("../security:audit")).toBe("..-security-audit.txt");
});
