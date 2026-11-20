import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveRoot = process.argv[2] ?? path.join(root, ".handoff/archive/2026-11-20-1659-zeta-agent-harness");
const manifestPath = path.join(archiveRoot, "manifest.json");

const failures = [];
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`PASS ${label}`);
  } else {
    console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
    failures.push(label);
  }
}

if (!existsSync(manifestPath)) {
  console.error(`FAIL manifest 不存在: ${manifestPath}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.error(`FAIL manifest 解析失败: ${err.message}`);
  process.exit(1);
}

for (const v of ["spec", "plan", "graph", "state", "resume"]) {
  check(`versions.${v} 存在`, manifest.versions?.[v] !== undefined);
}
check("files 为非空数组", Array.isArray(manifest.files) && manifest.files.length > 0);
check("files 数量 = 85", manifest.files?.length === 85, `实际 ${manifest.files?.length}`);
check("files 条目字段齐全", manifest.files.every((e) => e.path && e.sha256 && typeof e.bytes === "number"));

const sample = [manifest.files[0], manifest.files[Math.floor(manifest.files.length / 2)], manifest.files.at(-1)];
for (const entry of sample) {
  const full = path.join(archiveRoot, entry.path);
  if (!existsSync(full)) {
    check(`抽样 ${entry.path} 存在`, false);
    continue;
  }
  const bytes = readFileSync(full);
  const digest = createHash("sha256").update(bytes).digest("hex");
  check(`抽样 ${entry.path} 字节数`, bytes.length === entry.bytes, `实际 ${bytes.length}`);
  check(`抽样 ${entry.path} sha256`, digest === entry.sha256, `实际 ${digest.slice(0, 12)}…`);
}

if (failures.length > 0) {
  console.error(`\nverify-archive: ${failures.length} 项失败`);
  process.exit(1);
}
console.log("\nverify-archive: 归档完整可读");
