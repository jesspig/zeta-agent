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

const moduleSpecifierPattern = /["']([^"']+)["']/g;

const opentuiBusinessModules = new Set(["slots.ts", "signal.ts", "virtual.ts", "hud.ts", "frame.ts", "backend.ts"]);

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

const scanTargets = [
  ...appSrcDirs().map((dir) => ({ dir, opentuiBusinessCheck: false })),
  { dir: join(root, "packages/tui/src"), opentuiBusinessCheck: true },
  { dir: join(root, "packages/deploy/src"), opentuiBusinessCheck: false },
];

const violations = [];

for (const { dir, opentuiBusinessCheck } of scanTargets) {
  for (const file of walk(dir)) {
    const rel = relative(root, file).split(sep).join("/");
    const isBusinessModule = opentuiBusinessCheck && opentuiBusinessModules.has(file.split(sep).pop());
    const lines = readFileSync(file, "utf8").split(/\r?\n/);

    lines.forEach((line, index) => {
      for (const match of line.matchAll(moduleSpecifierPattern)) {
        const spec = match[1];
        if (!spec.startsWith("@zeta-agent/") && !spec.startsWith("@opentui/")) continue;

        const scopeMatch = /^(@[^/]+\/[^/]+)/.exec(spec);
        const pkg = scopeMatch ? scopeMatch[1] : spec;

        if (pkg.startsWith("@zeta-agent/") && !facadePackages.has(pkg)) {
          violations.push(`${rel}:${index + 1}: 禁止 import 组件内部实现 "${spec}"（只允许 facade 稳定入口）`);
        }
        if (isBusinessModule && (spec === "@opentui/solid" || spec.startsWith("@opentui/solid/"))) {
          violations.push(`${rel}:${index + 1}: 业务组件禁止直接 import "${spec}"（须经 RendererBackend seam）`);
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
