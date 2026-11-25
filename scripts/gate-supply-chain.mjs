import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkReleaseAges, parseSbomFromLockfile } from "../packages/testing/src/quality-gates.ts";
import { makeGate, readConfig, root, run, writeGates, writeJson } from "./gate-lib.mjs";

const config = readConfig();
const gates = [];

const lockText = readFileSync(join(root, "bun.lock"), "utf8");
let sbom;
try {
  sbom = parseSbomFromLockfile(lockText, "bun.lock");
} catch (error) {
  gates.push(
    makeGate({
      id: "supply:sbom",
      category: "supply-chain",
      name: "从 bun.lock 生成真实 SBOM",
      status: "fail",
      detail: error.message,
    })
  );
  writeGates("supply-chain", gates);
  process.exit(1);
}
writeJson("reports/sbom.json", sbom);
const sbomOk =
  sbom.components.length >= config.supplyChain.minSbomComponents &&
  sbom.components.every((item) => item.integrity.startsWith("sha512-"));
gates.push(
  makeGate({
    id: "supply:sbom",
    category: "supply-chain",
    name: "SBOM 组件完整性与摘要",
    status: sbomOk ? "pass" : "fail",
    detail: `${sbom.components.length} 个第三方组件（下限 ${config.supplyChain.minSbomComponents}），全部带 sha512 完整性摘要；来源 bun.lock`,
    evidence: [
      { kind: "file", ref: "bun.lock" },
      { kind: "file", ref: "reports/sbom.json" },
    ],
  })
);

const packageFiles = ["package.json"];
const workspaceRoots = ["apps/zeta-cli", "packages/agent", "packages/agent-components", "packages/agent-framework", "packages/components", "packages/components/capabilities", "packages/components/cordis", "packages/components/events", "packages/components/loader", "packages/components/observability", "packages/components/security", "packages/deploy", "packages/framework", "packages/testing", "packages/tui"];
for (const dir of workspaceRoots) {
  const path = join(dir, "package.json");
  if (existsSyncLocal(path)) packageFiles.push(path);
}
function existsSyncLocal(relative) {
  try {
    readFileSync(join(root, relative));
    return true;
  } catch {
    return false;
  }
}
const forbidden = config.supplyChain.forbiddenPackages;
const violations = [];
for (const file of packageFiles) {
  const pkg = JSON.parse(readFileSync(join(root, file), "utf8"));
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (forbidden.some((prefix) => name === prefix || name.startsWith(`${prefix}/`))) {
        violations.push(`${file}:${section}:${name}`);
      }
    }
  }
}
gates.push(
  makeGate({
    id: "supply:dependency-policy",
    category: "supply-chain",
    name: "依赖策略：禁止上游 Cordis 包",
    status: violations.length === 0 ? "pass" : "fail",
    detail: violations.length === 0 ? `${packageFiles.length} 个 package.json 无禁用依赖` : violations.join(", "),
    evidence: [{ kind: "file", ref: "package.json" }],
  })
);

const frozen = run("bun", ["install", "--frozen-lockfile"]);
gates.push(
  makeGate({
    id: "supply:frozen-lockfile",
    category: "supply-chain",
    name: "frozen lockfile 可复现安装",
    status: frozen.code === 0 ? "pass" : "fail",
    detail: `bun install --frozen-lockfile exit=${frozen.code}`,
    exitCode: frozen.code,
    evidence: [{ kind: "command", ref: "bun install --frozen-lockfile" }],
  })
);

/** release-age：只使用 npm registry 的真实发布时间；查询失败如实记为 skipped，不写 pass。 */
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const direct = Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies });
const versions = new Map(sbom.components.map((item) => [item.name, item.version]));
const inputs = [];
const queryFailures = [];
for (const name of direct) {
  const version = versions.get(name);
  if (version === undefined) {
    queryFailures.push(`${name}@${version ?? "?"}: SBOM 无对应版本`);
    continue;
  }
  const result = run("bun", ["pm", "view", name, "time", "--json"], { timeout: 60_000 });
  if (result.code !== 0) {
    queryFailures.push(`${name}@${version}: registry 不可得`);
    inputs.push({ name, version, publishedAt: null });
    continue;
  }
  try {
    const times = JSON.parse(result.stdout);
    inputs.push({ name, version, publishedAt: times[version] ?? null });
  } catch {
    inputs.push({ name, version, publishedAt: null });
    queryFailures.push(`${name}@${version}: 发布时间解析失败`);
  }
}
const age = checkReleaseAges(inputs, new Date(), config.supplyChain.releaseAgeMinDays);
writeJson("reports/release-ages.json", {
  generatedAt: new Date().toISOString(),
  minDays: age.minDays,
  inputs,
  result: age,
  queryFailures,
});
const ageOk = age.tooNew.length === 0 && age.checked > 0;
gates.push(
  makeGate({
    id: "supply:release-age",
    category: "supply-chain",
    name: `release-age ≥ ${age.minDays} 天`,
    status: ageOk ? "pass" : "unverified",
    scope: "network",
    detail: `已核验 ${age.checked} / 跳过 ${age.skipped}；过新 ${age.tooNew.join(", ") || "无"}${queryFailures.length > 0 ? `；查询失败: ${queryFailures.join("; ")}` : ""}`,
    evidence: [{ kind: "file", ref: "reports/release-ages.json" }],
  })
);

writeGates("supply-chain", gates);
for (const item of gates) console.log(`${item.status.toUpperCase()} ${item.id}: ${item.detail}`);
if (gates.some((item) => item.status === "fail")) process.exit(1);
