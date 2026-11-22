import { expect, test } from "bun:test";
import { pickCanonicalMakerEntry } from "./canonical-selection.js";

const bareOf = (id) => id.slice(id.lastIndexOf("/") + 1);

test("共享 canonical 时优先模型键与 canonical bare 一致的条目，且不受输入顺序影响", () => {
  const entries = [
    { providerId: "zhipuai", modelKey: "glm-5.3-flashx", model: { cost: { input: 2, output: 5 } } },
    { providerId: "zhipuai", modelKey: "glm-5.3-flash", model: { cost: { input: 1, output: 3 } } },
  ];
  const picked = pickCanonicalMakerEntry(entries, "zhipuai/glm-5.3-flash", "zhipuai", bareOf);
  expect(picked.modelKey).toBe("glm-5.3-flash");

  const reversed = pickCanonicalMakerEntry([...entries].reverse(), "zhipuai/glm-5.3-flash", "zhipuai", bareOf);
  expect(reversed.modelKey).toBe("glm-5.3-flash");
});
