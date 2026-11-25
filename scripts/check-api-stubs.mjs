/** T-27 A32：公开 API 不得残留显式未实现标记；静默降级由契约测试单独覆盖。 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STUB = /\bNOT_IMPLEMENTED\b|throw new Error\(\s*["']not implemented|TODO:\s*implement|unimplemented/i;

function walk(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      walk(path, output);
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !entry.name.includes(".spec.") && !entry.name.includes(".generated.")) {
      output.push(path);
    }
  }
  return output;
}

export function verifyApiStubs(root = ROOT) {
  const files = [
    ...walk(join(root, "packages")),
    ...walk(join(root, "apps")),
  ];
  const hits = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (STUB.test(line)) hits.push(`${file.replace(root, ".")}:${index + 1}`);
    });
  }
  return {
    ok: hits.length === 0,
    detail: hits.length === 0 ? `扫描 ${files.length} 个非测试源文件，无未实现标记` : `未实现标记: ${hits.join(", ")}`,
  };
}

if (import.meta.main) {
  const result = verifyApiStubs();
  console.log(`${result.ok ? "PASS" : "FAIL"} api-stubs: ${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}
