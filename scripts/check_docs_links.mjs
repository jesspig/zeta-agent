import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "docs/desgin");
const failures = [];
let linkCount = 0;
let anchorCount = 0;

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[\p{P}\p{S}]/gu, (ch) => (ch === "-" || ch === "_" ? ch : ""))
    .replace(/[ \t]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function anchorsOf(md) {
  const set = new Set();
  for (const m of md.matchAll(/^#{1,6}\s+(.+)$/gm)) set.add(slug(m[1]));
  set.add("");
  return set;
}

const files = walk(root);
for (const file of files) {
  const md = readFileSync(file, "utf8");
  const selfAnchors = anchorsOf(md);
  for (const m of md.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = m[1].trim();
    if (/^(https?:|mailto:)/.test(raw)) continue;
    const [target, anchor] = raw.split("#");
    if (target) {
      linkCount += 1;
      const resolved = resolve(dirname(file), target);
      if (!existsSync(resolved)) {
        failures.push(`${file}: 断链 ${raw}`);
        continue;
      }
      if (anchor !== undefined && resolved.endsWith(".md")) {
        anchorCount += 1;
        const targetAnchors = anchorsOf(readFileSync(resolved, "utf8"));
        if (!targetAnchors.has(slug(anchor))) failures.push(`${file}: 断锚 ${raw}`);
      }
    } else if (anchor !== undefined) {
      anchorCount += 1;
      if (!selfAnchors.has(slug(anchor))) failures.push(`${file}: 断锚 ${raw}`);
    }
  }
}

console.log(`扫描 ${files.length} 个 MD / ${linkCount} 链接 / ${anchorCount} 锚点`);
if (failures.length > 0) {
  console.error(`FAIL ${failures.length} 项: ${failures.slice(0, 20).join(" | ")}`);
  process.exit(1);
}
console.log("PASS 0 断链 0 断锚");
