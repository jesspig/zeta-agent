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
// 使用 TypeScript AST 提取模块名，覆盖多行 import/export 与动态字面量导入，
// 不再依赖单行正则（后者会漏掉跨行的值依赖）。
let ts;
try {
  ts = (await import("typescript")).default;
} catch {
  console.error("#9 依赖检查失败：缺少 typescript，无法进行 AST 扫描");
  process.exit(2);
}

let scannedFiles = 0;
for (const file of walk(scanDir)) {
  scannedFiles += 1;
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const checkSpec = (spec, line, typeOnly) => {
    if (typeof spec !== "string" || typeOnly) return;
    for (const { re, label } of forbiddenPatterns) {
      if (re.test(spec)) violations.push(`${relative(root, file).split(sep).join("/")}:${line}: 禁止 ${label} import "${spec}"`);
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      checkSpec(node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined, line, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      checkSpec(node.moduleSpecifier.text, line, node.isTypeOnly === true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        checkSpec(arg.text, line, false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
if (scannedFiles === 0) {
  console.error("#9 依赖检查失败：未扫描到任何源文件");
  process.exit(1);
}

if (violations.length > 0) {
  console.error("#9 依赖检查失败：runtime 层存在禁止的 import");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log(`#9 依赖检查通过：${relative(root, scanDir).split(sep).join("/")} 无持久化/provider 运行时依赖`);
