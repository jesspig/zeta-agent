// #9 架构门禁：静态扫描 runtime/*.ts 的 import，断言 core 无持久化/provider 依赖。
// 只读源码，不改测试行为；检测到违规 import 时非 0 退出。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "packages/agent-framework/src/runtime");
// 允许通过的可选目标目录（用于自测注入 fixture），默认只扫真实 runtime。
const scanDir = process.argv[2] ? resolve(process.argv[2]) : runtimeDir;

// 禁止的依赖模式：持久化实现、provider/后端实现（type-only import 由 useScanRule 豁免）。
const forbiddenPatterns = [
  { re: /(?:@zeta-agent\/)?(?:deploy|session-persistence|persistence)(?:\/|$)/, label: "持久化" },
  { re: /(?:@zeta-agent\/)?provider(?:s)?(?:\/|$)/, label: "provider/后端" },
  { re: /(?:^|\/)node:sqlite\b/, label: "sqlite 持久化" },
];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(entry) ? [full] : [];
  });
}

const violations = [];
const importRe = /^\s*(?:import|export)\s+(?:type\s+)?.*?from\s*["']([^"']+)["']/gm;
const bareImportRe = /^\s*import\s*["']([^"']+)["']/gm;

for (const file of walk(scanDir)) {
  const source = readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/);
  for (const match of source.matchAll(importRe)) {
    const before = source.slice(0, match.index);
    const line = before.split("\n").length;
    const spec = match[1];
    const isTypeOnly = /^\s*import\s+type\b/.test(lines[line - 1] ?? "") || /^\s*export\s+type\b/.test(lines[line - 1] ?? "");
    if (isTypeOnly) continue; // 白名单：type-only import 不产生运行时依赖
    for (const { re, label } of forbiddenPatterns) {
      if (re.test(spec)) {
        violations.push(`${relative(root, file).split(sep).join("/")}:${line}: 禁止 ${label} import "${spec}"`);
      }
    }
  }
  for (const match of source.matchAll(bareImportRe)) {
    const before = source.slice(0, match.index);
    const line = before.split("\n").length;
    const spec = match[1];
    for (const { re, label } of forbiddenPatterns) {
      if (re.test(spec)) {
        violations.push(`${relative(root, file).split(sep).join("/")}:${line}: 禁止 ${label} import "${spec}"`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("#9 依赖检查失败：runtime 层存在禁止的 import");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log(`#9 依赖检查通过：${relative(root, scanDir).split(sep).join("/")} 无持久化/provider 运行时依赖`);
