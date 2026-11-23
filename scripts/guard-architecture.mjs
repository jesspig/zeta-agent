import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const facadePackages = new Set([
  "@zeta-agent/framework",
  "@zeta-agent/agent-framework",
  "@zeta-agent/agent",
  "@zeta-agent/tui",
  "@zeta-agent/components",
  "@zeta-agent/agent-components",
  "@zeta-agent/deploy",
  "@zeta-agent/testing",
  "@zeta-agent/cli",
]);

// facade/聚合包在装配时可合法依赖的组件子包；apps/tui/deploy 仍只放行 facadePackages。
const componentPackages = new Set([
  "@zeta-agent/cordis",
  "@zeta-agent/events",
  "@zeta-agent/capabilities",
  "@zeta-agent/loader",
  "@zeta-agent/observability",
  "@zeta-agent/security",
]);

const moduleSpecifierPattern = /["']([^"']+)["']/g;

// 只有模块语句行才可能包含真实的模块说明符。普通代码字符串、JSDoc 注释、
// 测试夹具字符串中的说明符-shaped 字面量一律跳过，避免误报。
const staticImportExportLine = /^\s*(?:import|export)\b/;
const multilineFromLine = /^\s*\}\s*from\b/;
const dynamicImportLine = /\bimport\s*\(/;
const isModuleStatementLine = (line) =>
  staticImportExportLine.test(line) || multilineFromLine.test(line) || dynamicImportLine.test(line);

const opentuiBusinessModules = new Set(["slots.ts", "signal.ts", "virtual.ts", "hud.ts", "frame-state.ts", "backend.ts"]);

// 受控 seam：仅这两个文件允许直接 import @opentui/*（运行时插件加载与官方 Solid slots 适配）。
// facade string 槽位契约（slots.ts）与业务组件仍禁止直接依赖 OpenTUI。
const opentuiSeamAllowlist = new Set(["runtime-plugin-loader.tsx", "slots-native.tsx"]);

function walk(dir) {
  const result = [];
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) result.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) result.push(full);
  }
  return result;
}

function appSrcDirs() {
  const base = join(root, "apps");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(base, e.name, "src"))
    .filter((d) => existsSync(d));
}

// packages/*/src 中的 facade/聚合层（不含 tui 与 deploy）。
const facadeAggregationPackages = [
  "framework",
  "agent-framework",
  "agent",
  "components",
  "agent-components",
  "testing",
];

function facadeAggregationSrcDirs() {
  return facadeAggregationPackages
    .map((name) => join(root, "packages", name, "src"))
    .filter((d) => existsSync(d));
}

// facade/聚合层允许 facadePackages ∪ componentPackages；apps/tui/deploy 仍只允许 facadePackages。
const facadeAllowedPackages = facadePackages;
const aggregationAllowedPackages = new Set([...facadePackages, ...componentPackages]);

const scanTargets = [
  ...appSrcDirs().map((dir) => ({ dir, opentuiBusinessCheck: false, allowComponentPackages: false })),
  { dir: join(root, "packages/tui/src"), opentuiBusinessCheck: true, allowComponentPackages: false },
  { dir: join(root, "packages/deploy/src"), opentuiBusinessCheck: false, allowComponentPackages: false },
  ...facadeAggregationSrcDirs().map((dir) => ({ dir, opentuiBusinessCheck: false, allowComponentPackages: true })),
];

const violations = [];

for (const { dir, opentuiBusinessCheck, allowComponentPackages } of scanTargets) {
  const allowedPackages = allowComponentPackages ? aggregationAllowedPackages : facadeAllowedPackages;
  for (const file of walk(dir)) {
    const rel = relative(root, file).split(sep).join("/");
    const isBusinessModule = opentuiBusinessCheck && opentuiBusinessModules.has(file.split(sep).pop());
    const lines = readFileSync(file, "utf8").split(/\r?\n/);

    lines.forEach((line, index) => {
      if (!isModuleStatementLine(line)) return;
      for (const match of line.matchAll(moduleSpecifierPattern)) {
        const spec = match[1];
        if (!spec.startsWith("@zeta-agent/") && !spec.startsWith("@opentui/")) continue;

        const scopeMatch = /^(@[^/]+\/[^/]+)/.exec(spec);
        const pkg = scopeMatch ? scopeMatch[1] : spec;

        if (pkg.startsWith("@zeta-agent/") && !allowedPackages.has(pkg)) {
          violations.push(`${rel}:${index + 1}: 禁止 import 组件内部实现 "${spec}"（只允许 facade 稳定入口）`);
        }
        if (isBusinessModule && (spec === "@opentui/solid" || spec.startsWith("@opentui/solid/"))) {
          violations.push(`${rel}:${index + 1}: 业务组件禁止直接 import "${spec}"（须经 RendererBackend seam）`);
        }
        // 运行时插件 API 仅允许在受控 seam 文件中直接 import，隔离加载失败风险。
        if (
          opentuiBusinessCheck &&
          (spec.startsWith("@opentui/core/runtime-plugin") ||
            spec.startsWith("@opentui/solid/runtime-plugin-support")) &&
          !opentuiSeamAllowlist.has(file.split(sep).pop())
        ) {
          violations.push(`${rel}:${index + 1}: 运行时插件 API 仅允许在受控 seam（${[...opentuiSeamAllowlist].join(", ")}）中直接 import`);
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error("架构守护失败：");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`架构守护通过：扫描 ${scanTargets.length} 个目录，未发现违规导入`);
