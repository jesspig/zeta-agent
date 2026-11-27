import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = (await import("typescript")).default;

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
  "@zeta-agent/process",
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

// 组件包只能依赖组件包；facade/聚合包是它的上游，不允许反向依赖。
function componentPackageNames(workspaceRoot) {
  const names = new Set();
  const componentDir = join(workspaceRoot, "packages", "components");
  for (const file of walk(componentDir, (item) => item.endsWith(`${sep}package.json`))) {
    if (relative(componentDir, dirname(file)).split(sep).length !== 1) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (typeof manifest.name === "string") names.add(manifest.name);
  }
  return names;
}

export function findComponentFacadeDependencies(workspaceRoot = root) {
  const violations = [];
  const components = componentPackageNames(workspaceRoot);
  const componentDir = join(workspaceRoot, "packages", "components");
  for (const file of walk(componentDir, (item) => item.endsWith(`${sep}package.json`))) {
    if (relative(componentDir, dirname(file)).split(sep).length !== 1) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const field of dependencyFields) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (name.startsWith("@zeta-agent/") && !components.has(name)) {
          violations.push(
            `${relative(workspaceRoot, file).split(sep).join("/")}: 组件包禁止反向依赖 facade "${name}"`
          );
        }
      }
    }
  }
  // 源码级：即便 manifest 未声明，组件源码也不得 import facade/聚合包。
  for (const file of walk(componentDir, (item) => /\.[cm]?[jt]sx?$/.test(item))) {
    const segments = relative(componentDir, file).split(sep);
    if (segments.length < 2) continue;
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const { specifier, node } of moduleSpecifiers(sourceFile)) {
      const matched = /^(@[^/]+\/[^/]+)/.exec(specifier);
      if (!matched || !matched[1].startsWith("@zeta-agent/") || components.has(matched[1])) continue;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      violations.push(
        `${relative(workspaceRoot, file).split(sep).join("/")}:${line}: 组件源码禁止反向依赖 facade "${specifier}"`
      );
    }
  }
  return violations;
}

// 组件内部只能经 package.json 声明的稳定子路径访问，禁止直连 src/ 等实现路径。
export function findDisallowedComponentSubpaths(workspaceRoot = root) {
  const violations = [];
  const components = componentPackageNames(workspaceRoot);
  const declared = new Map();
  for (const file of packageManifests(workspaceRoot)) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (!components.has(manifest.name)) continue;
    const subpaths = new Set(Object.keys(manifest.exports ?? {}));
    declared.set(manifest.name, subpaths);
  }
  for (const base of ["packages", "apps"]) {
    for (const file of walk(join(workspaceRoot, base), (item) => /\.[cm]?[jt]sx?$/.test(item))) {
      const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const { specifier, node } of moduleSpecifiers(sourceFile)) {
        const matched = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(specifier);
        if (!matched) continue;
        const [, pkg, rawSubpath] = matched;
        if (!components.has(pkg) || rawSubpath === undefined) continue;
        const subpath = rawSubpath.startsWith("./") ? rawSubpath : `./${rawSubpath.slice(1)}`;
        if (!(declared.get(pkg) ?? new Set()).has(subpath)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          violations.push(
            `${relative(workspaceRoot, file).split(sep).join("/")}:${line}: 禁止直连组件内部 "${specifier}"（稳定入口见 ${pkg} exports）`
          );
        }
      }
    }
  }
  return violations;
}

// 受控 seam：仅这两个文件允许直接 import @opentui/*（运行时插件加载与官方 Solid slots 适配）。
// facade string 槽位契约（slots.ts）与业务组件仍禁止直接依赖 OpenTUI。
const opentuiSeamAllowlist = new Set(["runtime-plugin-loader.tsx", "slots-native.tsx"]);

const ignoredDirectories = new Set(["node_modules", "dist", ".git", ".worktrees", ".turbo"]);
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const testFilePattern = /(?:\.spec|\.test|\.test-d)\.[cm]?[jt]sx?$/;

function walk(dir, predicate = () => true) {
  const result = [];
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir)) {
    if (ignoredDirectories.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) result.push(...walk(full, predicate));
    else if (predicate(full)) result.push(full);
  }
  return result;
}

function packageManifests(workspaceRoot) {
  const manifests = [];
  for (const base of ["packages", "apps"]) {
    manifests.push(...walk(join(workspaceRoot, base), (file) => file.endsWith(`${sep}package.json`)));
  }
  return manifests.sort();
}

function packageRootOf(file, workspaceRoot) {
  let cursor = dirname(file);
  while (cursor.startsWith(workspaceRoot)) {
    if (existsSync(join(cursor, "package.json"))) return cursor;
    if (cursor === workspaceRoot) break;
    cursor = dirname(cursor);
  }
  return undefined;
}

function moduleSpecifiers(sourceFile) {
  const specs = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specs.push({ specifier: node.moduleSpecifier.text, node });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) specs.push({ specifier: argument.text, node });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression)) specs.push({ specifier: expression.text, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specs;
}

export function collectPackageGraph(workspaceRoot = root) {
  const graph = new Map();
  const names = new Map();
  for (const file of packageManifests(workspaceRoot)) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (typeof manifest.name !== "string") continue;
    if (names.has(manifest.name)) {
      throw new Error(`重复 workspace package 身份 ${manifest.name}: ${names.get(manifest.name)} 与 ${file}`);
    }
    names.set(manifest.name, file);
    const dependencies = [];
    for (const field of dependencyFields) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (name.startsWith("@zeta-agent/") && !dependencies.includes(name)) dependencies.push(name);
      }
    }
    graph.set(manifest.name, dependencies.sort());
  }
  return graph;
}

export function detectPackageCycles(graph) {
  const state = new Map();
  const stack = [];
  const cycles = [];
  const visit = (name) => {
    const status = state.get(name) ?? 0;
    if (status === 1) {
      const start = stack.indexOf(name);
      cycles.push([...stack.slice(start), name]);
      return;
    }
    if (status === 2) return;
    state.set(name, 1);
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    stack.pop();
    state.set(name, 2);
  };
  for (const name of graph.keys()) visit(name);
  return cycles;
}

export function findCrossPackageRelativeImports(workspaceRoot = root) {
  const violations = [];
  const manifests = packageManifests(workspaceRoot);
  for (const manifestFile of manifests) {
    const packageRoot = dirname(manifestFile);
    const packageName = JSON.parse(readFileSync(manifestFile, "utf8")).name;
    const sourceFiles = walk(packageRoot, (file) => /\.[cm]?[jt]sx?$/.test(file))
      .filter((file) => packageRootOf(file, workspaceRoot) === packageRoot);
    for (const file of sourceFiles) {
      const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const { specifier, node } of moduleSpecifiers(sourceFile)) {
        if (!specifier.startsWith(".")) continue;
        const targetRoot = packageRootOf(resolve(dirname(file), specifier), workspaceRoot);
        if (!targetRoot || targetRoot === packageRoot) continue;
        const targetManifest = join(targetRoot, "package.json");
        if (!existsSync(targetManifest)) continue;
        const targetName = JSON.parse(readFileSync(targetManifest, "utf8")).name;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        violations.push(
          `${relative(workspaceRoot, file).split(sep).join("/")}:${line}: 禁止跨包相对 import ${packageName} -> ${targetName} (${specifier})`
        );
      }
    }
  }
  return violations;
}

export function validateSharedPeerIdentity(workspaceRoot = root) {
  const graph = collectPackageGraph(workspaceRoot);
  const violations = [];
  const peers = new Map();
  for (const file of packageManifests(workspaceRoot)) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!graph.has(name)) continue;
      const declarations = peers.get(name) ?? [];
      declarations.push({ package: manifest.name, range, file });
      peers.set(name, declarations);
    }
  }
  for (const [name, declarations] of peers) {
    const ranges = new Set(declarations.map((item) => item.range));
    if (ranges.size > 1) {
      violations.push(
        `共享 peer 身份冲突 ${name}: ${declarations.map((item) => `${item.package}=${item.range}`).join(", ")}`
      );
    }
    for (const declaration of declarations) {
      if (declaration.range !== "workspace:*") {
        violations.push(
          `${relative(workspaceRoot, declaration.file).split(sep).join("/")}: peer ${name} 必须使用 workspace:* 以保持单一身份`
        );
      }
    }
  }
  return violations;
}

const coreTypeNames = new Set([
  "FiberId",
  "Disposer",
  "EffectIterator",
  "Effect",
  "OperationSet",
  "CoeffectKey",
  "Impl",
  "FiberContext",
  "EffectCallback",
  "ExecuteFn",
  "Component",
  "LifecycleState",
  "View",
]);

export function findCoreTypeDeclarations(workspaceRoot = root) {
  const declarations = [];
  const files = walk(join(workspaceRoot, "packages"), (file) =>
    /\.[cm]?[jt]sx?$/.test(file) && !testFilePattern.test(file)
  );
  for (const file of files) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        coreTypeNames.has(node.name.text)
      ) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        declarations.push({
          name: node.name.text,
          file: relative(workspaceRoot, file).split(sep).join("/"),
          line,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return declarations;
}

export function inventoryRootContextReads(workspaceRoot = root) {
  const reads = [];
  const frameworkSources = walk(join(workspaceRoot, "packages/framework/src"), (file) =>
    /\.[cm]?[jt]sx?$/.test(file) && !testFilePattern.test(file)
  );
  for (const file of frameworkSources) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ((ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "get" &&
          /^(?:ctx|context)$/.test(node.expression.expression.getText(sourceFile))) ||
          (ts.isIdentifier(node.expression) && node.expression.text === "reflectGet"))
      ) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        reads.push(`${relative(workspaceRoot, file).split(sep).join("/")}:${line}: ${node.expression.getText(sourceFile)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return reads;
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

export function guardArchitecture(workspaceRoot = root) {
  const violations = [];
  const graph = collectPackageGraph(workspaceRoot);
  for (const cycle of detectPackageCycles(graph)) {
    violations.push(`package graph 存在环: ${cycle.join(" -> ")}`);
  }
  violations.push(...findCrossPackageRelativeImports(workspaceRoot));
  violations.push(...validateSharedPeerIdentity(workspaceRoot));
  violations.push(...findComponentFacadeDependencies(workspaceRoot));
  violations.push(...findDisallowedComponentSubpaths(workspaceRoot));
  for (const declaration of findCoreTypeDeclarations(workspaceRoot)) {
    if (declaration.file !== "packages/components/cordis/src/types.ts") {
      violations.push(
        `核心类型 ${declaration.name} 必须唯一归属 @zeta-agent/cordis: ${declaration.file}:${declaration.line}`
      );
    }
  }

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
  return violations;
}

function main() {
  try {
    const violations = guardArchitecture();
    if (violations.length > 0) {
      console.error("架构守护失败：");
      for (const violation of violations) console.error(`  ${violation}`);
      process.exit(1);
    }
    const reads = inventoryRootContextReads();
    console.log(`架构守护通过：${collectPackageGraph().size} 个 package，扫描 ${scanTargets.length} 个目录，未发现违规导入`);
    console.log(`根上下文读取库存：${reads.length} 处`);
    for (const read of reads) console.log(`  ${read}`);
  } catch (error) {
    console.error(`架构守护失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
