// 要点关键词门（门 2）：校验 invariants.spec.ts 的 INVARIANT_TEST_POINTS 映射表。
// 只读源码，不修改测试行为；缺失映射表或条目不全时以非 0 退出。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = join(root, "packages/agent-framework/src/runtime/invariants.spec.ts");
const failures = [];

if (!existsSync(spec)) {
  failures.push(`找不到断言文件：${spec}`);
} else {
  const source = readFileSync(spec, "utf8");
  const tableStart = source.indexOf("INVARIANT_TEST_POINTS");
  if (tableStart === -1) {
    failures.push("缺少 INVARIANT_TEST_POINTS 映射表");
  } else {
    const afterTable = source.slice(tableStart);
    const entryPattern = /(\d+):\s*\{[^}]*?point:\s*"([^"]*)"[^}]*?keywords:\s*\[([^\]]*)\][^}]*?assertFragment:\s*"([^"]*)"/g;
    const found = new Map();
    for (const match of afterTable.matchAll(entryPattern)) {
      const id = Number(match[1]);
      if (found.has(id)) failures.push(`映射表条目 #${id} 重复`);
      const keywords = match[3]
        .split(",")
        .map((part) => part.trim().replace(/^["']|["']$/g, ""))
        .filter((part) => part.length > 0);
      found.set(id, { point: match[2], keywords, fragment: match[4] });
    }
    for (let id = 1; id <= 12; id += 1) {
      const entry = found.get(id);
      if (entry === undefined) {
        failures.push(`映射表缺少要点 #${id}`);
        continue;
      }
      if (entry.point.length === 0) failures.push(`要点 #${id} 的 point 为空`);
      if (entry.keywords.length === 0) failures.push(`要点 #${id} 没有 keywords`);
      if (entry.fragment.length === 0) failures.push(`要点 #${id} 没有 assertFragment`);
    }
    if (found.size !== 12) failures.push(`映射表条目数应为 12，实际 ${found.size}`);
  }
}

if (failures.length > 0) {
  console.error("要点关键词门失败：");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("要点关键词门通过：INVARIANT_TEST_POINTS 覆盖 1-12，每条含 point/keywords/assertFragment");
