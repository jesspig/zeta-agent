/** T-27 A2：核验事实登记 P1-P10 每行都指向真实存在的文件与测试/检查脚本。 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "docs/desgin/architecture/fact-registry.md");

function walk(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, output);
    else output.push(path);
  }
  return output;
}

export function verifyFactRegistry(root = ROOT) {
  const text = readFileSync(REGISTRY, "utf8");
  const files = walk(join(root, "packages")).concat(walk(join(root, "scripts")), walk(join(root, "apps")));
  const baseNames = new Set(files.map((path) => path.split(/[\\/]/).at(-1) ?? ""));
  const rows = text.split("\n").filter((line) => /^\| P(?:[1-9]|10)\s/.test(line));
  const problems = [];
  for (let i = 1; i <= 10; i += 1) {
    const row = rows.find((line) => line.startsWith(`| P${i} `));
    if (row === undefined) {
      problems.push(`P${i} 行缺失`);
      continue;
    }
    const refs = [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
    const impl = refs.find((ref) => /^(packages|scripts|apps)\//.test(ref) && existsSync(join(root, ref)));
    const verify = refs.find(
      (ref) => /\.spec\.[cm]?[jt]sx?$/.test(ref) && baseNames.has(ref.split(/[\\/]/).at(-1) ?? "")
    );
    const script = refs.find((ref) => /^(scripts)\/.*\.mjs$/.test(ref) && existsSync(join(root, ref)));
    if (impl === undefined) problems.push(`P${i} 缺少存在的实现路径`);
    if (verify === undefined && script === undefined) problems.push(`P${i} 缺少测试或检查脚本`);
  }
  return {
    ok: problems.length === 0,
    detail: problems.length === 0 ? "P1-P10 均指向存在的实现文件与测试/检查脚本" : problems.join(" | "),
  };
}

if (import.meta.main) {
  const result = verifyFactRegistry();
  console.log(`${result.ok ? "PASS" : "FAIL"} fact-registry: ${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}
