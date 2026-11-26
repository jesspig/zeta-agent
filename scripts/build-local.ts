import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_BUILD_PLANS,
  buildPlanFor,
  hostTarget,
  sha256Hex,
  verifyArtifactManifest,
  type ArtifactManifest,
  type EmbeddedResource,
  type LocalBuildPlan,
} from "../packages/deploy/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliSource = join(root, "apps/zeta-cli/src");
const generatedFile = join(cliSource, "embedded-assets.generated.ts");
const assetsRoot = join(root, "apps/zeta-cli/assets");
const catalogPath = join(assetsRoot, "resource-catalog.zetaasset");
const trackedMarkerPath = join(assetsRoot, "arch-marker.zetaasset");
const contentAssets = [
  { id: "system-prompt", path: join(assetsRoot, "prompts/system.md") },
  { id: "skills-index", path: join(assetsRoot, "skills/builtins/SKILL.md") },
  { id: "config-schema", path: join(assetsRoot, "schema/config.zetaasset") },
] as const;
const outputRoot = join(root, "dist/local");

/** 架构标记只描述目标可执行格式的机器码，不是伪造的原生库。 */
function archMarkerBytes(plan: LocalBuildPlan): Uint8Array {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  if (plan.os === "linux") {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], 0);
    view.setUint16(18, plan.arch === "x64" ? 0x3e : 0xb7, true);
  } else if (plan.os === "darwin") {
    bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
    view.setUint32(4, plan.arch === "x64" ? 0x01000007 : 0x0100000c, true);
  } else {
    bytes.set([0x4d, 0x5a], 0);
    view.setUint32(0x3c, 0x78, true);
    bytes.set([0x50, 0x45, 0x00, 0x00], 0x78);
    view.setUint16(0x7c, plan.arch === "x64" ? 0x8664 : 0xaa64, true);
  }
  return bytes;
}

function dataResource(id: string, path: string): EmbeddedResource {
  const bytes = readFileSync(path);
  return {
    id,
    kind: "data",
    arch: "universal",
    path: relative(assetsRoot, path).split(sep).join("/"),
    bytes: bytes.byteLength,
    sha256: sha256Hex(new Uint8Array(bytes)),
  };
}

function contentResources(): EmbeddedResource[] {
  return contentAssets.map((asset) => dataResource(asset.id, asset.path));
}

function embeddedResources(plan: LocalBuildPlan, markerPath: string): EmbeddedResource[] {
  const marker = readFileSync(markerPath);
  return [
    {
      id: "arch-marker",
      kind: "native",
      arch: plan.arch,
      path: "arch-marker.zetaasset",
      bytes: marker.byteLength,
      sha256: sha256Hex(new Uint8Array(marker)),
    },
    dataResource("resource-catalog", catalogPath),
    ...contentResources(),
  ];
}

/** 源码模式没有可执行文件架构可比，默认 manifest 把标记当普通数据资源。 */
function defaultResources(): EmbeddedResource[] {
  return [
    dataResource("arch-marker", trackedMarkerPath),
    dataResource("resource-catalog", catalogPath),
    ...contentResources(),
  ];
}

function importPathFromCliSource(target: string): string {
  const path = relative(cliSource, target).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

const IDENTIFIERS: Readonly<Record<string, string>> = Object.freeze({
  "arch-marker": "archMarker",
  "resource-catalog": "resourceCatalog",
  "system-prompt": "systemPrompt",
  "skills-index": "skillsIndex",
  "config-schema": "configSchema",
});

function writeGenerated(
  plan: LocalBuildPlan,
  assetPaths: Readonly<Record<string, string>>,
  resources: readonly EmbeddedResource[]
): void {
  const ids = resources.map((item) => item.id);
  const imports = ids
    .map((id) => {
      const identifier = IDENTIFIERS[id];
      if (identifier === undefined) throw new Error(`EMBEDDED_ID_UNMAPPED: ${id}`);
      return `import ${identifier} from ${JSON.stringify(importPathFromCliSource(assetPaths[id] ?? ""))} with { type: "file" };`;
    })
    .join("\n");
  const entries = ids.map((id) => `  ${JSON.stringify(id)}: ${IDENTIFIERS[id]},`).join("\n");
  const encoded = resources
    .map((item) => JSON.stringify(item, null, 2).split("\n").map((line) => `    ${line}`).join("\n"))
    .join(",\n");
  const body = `// 由 scripts/build-local.ts 按构建 target 生成；源码模式下使用当前宿主默认值。
// 自指二进制哈希不写入嵌入 manifest；发布目录的 manifest.json 才记录它。
${imports}
import type { ArtifactManifest } from "@zeta-agent/deploy";

export const EMBEDDED_ASSETS: Readonly<Record<string, string>> = Object.freeze({
${entries}
});

export const EMBEDDED_MANIFEST: ArtifactManifest = {
  version: 1,
  target: ${JSON.stringify(plan.target)},
  binary: { arch: ${JSON.stringify(plan.arch)}, path: ${JSON.stringify(plan.binaryName)}, bytes: 0 },
  embedded: [
${encoded}
  ],
};
`;
  writeFileSync(generatedFile, body, "utf8");
}

async function buildOne(plan: LocalBuildPlan): Promise<ArtifactManifest> {
  const targetDir = join(outputRoot, plan.target);
  mkdirSync(targetDir, { recursive: true });
  const markerPath = join(targetDir, "arch-marker.zetaasset");
  writeFileSync(markerPath, archMarkerBytes(plan));

  const paths: Record<string, string> = {
    "arch-marker": markerPath,
    "resource-catalog": catalogPath,
    ...Object.fromEntries(contentAssets.map((asset) => [asset.id, asset.path])),
  };
  const resources = embeddedResources(plan, markerPath);
  writeGenerated(plan, paths, resources);

  const result = await Bun.build({
    entrypoints: [join(cliSource, "index.ts")],
    outdir: targetDir,
    cwd: root,
    target: plan.bunTarget,
    compile: true,
    minify: true,
    assets: [markerPath, catalogPath, ...contentAssets.map((asset) => asset.path)],
  });
  if (!result.success) {
    throw new Error(`BUILD_FAILED: ${plan.target}: ${result.logs.map(String).join(" | ")}`);
  }
  const built = result.outputs[0];
  if (built === undefined) throw new Error(`BUILD_NO_OUTPUT: ${plan.target}`);
  if (basename(built.path) !== plan.binaryName) {
    renameSync(built.path, join(targetDir, plan.binaryName));
  }

  const binaryPath = join(targetDir, plan.binaryName);
  const bytes = readFileSync(binaryPath);
  const manifest: ArtifactManifest = {
    version: 1,
    target: plan.target,
    binary: {
      arch: plan.arch,
      path: plan.binaryName,
      bytes: bytes.byteLength,
      sha256: sha256Hex(new Uint8Array(bytes)),
    },
    embedded: resources,
  };
  verifyArtifactManifest(manifest);
  writeFileSync(join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function requestedPlans(argv: readonly string[]): LocalBuildPlan[] {
  if (argv.includes("--all")) return [...LOCAL_BUILD_PLANS];
  const explicit = argv.filter((arg) => arg.startsWith("--target=")).map((arg) => arg.slice("--target=".length));
  if (explicit.length > 0) return explicit.map(buildPlanFor);
  const host = hostTarget();
  if (host === undefined) throw new Error("HOST_TARGET_UNKNOWN: 请用 --target 指定构建目标");
  return [buildPlanFor(host)];
}

const originalGenerated = existsSync(generatedFile) ? readFileSync(generatedFile, "utf8") : undefined;
try {
  const plans = requestedPlans(process.argv.slice(2));
  for (const plan of plans) {
    const manifest = await buildOne(plan);
    const size = statSync(join(outputRoot, plan.target, plan.binaryName)).size;
    console.log(`PASS ${plan.target} ${plan.bunTarget} -> ${plan.binaryName} (${size} bytes, ${manifest.binary.sha256})`);
  }
  console.log(`build-local: ${plans.length} target(s) built`);
} finally {
  // 构建期会把 generated 文件临时指向 dist/local 目标目录的 marker；
  // 无论成功或异常，都必须按进入脚本前的字节原样恢复源码，绝不留下跨包相对 import。
  if (originalGenerated !== undefined) {
    writeFileSync(generatedFile, originalGenerated, "utf8");
  } else {
    const host = hostTarget();
    if (host !== undefined) {
      const plan = buildPlanFor(host);
      const paths: Record<string, string> = {
        "arch-marker": trackedMarkerPath,
        "resource-catalog": catalogPath,
        ...Object.fromEntries(contentAssets.map((asset) => [asset.id, asset.path])),
      };
      writeGenerated(plan, paths, defaultResources());
    }
  }
  if (existsSync(generatedFile) && readFileSync(generatedFile, "utf8").includes("dist/local")) {
    throw new Error("BUILD_SOURCE_POLLUTION: embedded-assets.generated.ts still references dist/local");
  }
}
