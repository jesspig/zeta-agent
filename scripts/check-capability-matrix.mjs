/** T-27 A39：校验能力矩阵中的机器可读装配清单与真实 builtin 注册表一致。 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSEMBLY_PROFILES, builtinIdsForProfile } from "../packages/agent/src/assembly/builtins.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX = join(ROOT, "docs/desgin/delivery/capability-matrix.md");

export function verifyCapabilityMatrix(root = ROOT) {
  if (!existsSync(MATRIX)) return { ok: false, detail: `能力矩阵不存在: ${MATRIX}` };
  const text = readFileSync(MATRIX, "utf8");
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
  const block = blocks.find((body) => body.includes("\"profiles\""));
  if (block === undefined) return { ok: false, detail: "未找到装配清单 json 块" };
  let doc;
  try {
    doc = JSON.parse(block);
  } catch (error) {
    return { ok: false, detail: `装配清单 JSON 解析失败: ${String(error)}` };
  }
  const docProfiles = Object.keys(doc.profiles ?? {}).sort();
  const codeProfiles = [...ASSEMBLY_PROFILES].sort();
  if (JSON.stringify(docProfiles) !== JSON.stringify(codeProfiles)) {
    return { ok: false, detail: `profile 不一致: doc=${docProfiles.join(",")} code=${codeProfiles.join(",")}` };
  }
  const problems = [];
  for (const profile of codeProfiles) {
    const docIds = [...(doc.profiles?.[profile] ?? [])].sort();
    const codeIds = [...builtinIdsForProfile(profile)].sort();
    if (JSON.stringify(docIds) !== JSON.stringify(codeIds)) {
      problems.push(`${profile}: doc=[${docIds.join(",")}] code=[${codeIds.join(",")}]`);
    }
  }
  return {
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `装配清单一致：${codeProfiles.map((p) => `${p}=${builtinIdsForProfile(p).length}`).join(" ")}`
        : problems.join(" | "),
  };
}

if (import.meta.main) {
  const result = verifyCapabilityMatrix();
  console.log(`${result.ok ? "PASS" : "FAIL"} capability-matrix: ${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}
