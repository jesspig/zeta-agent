// 要点关键词门（门 2）：校验 invariants.spec.ts 的 INVARIANT_TEST_POINTS 映射表，
// 并验证每条 §13 要点的哨兵与关键词确实命中对应的断言块（不只是表本身）。
// 只读源码，不修改测试行为；缺失映射表、条目不全或关键词未命中时非 0 退出。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = join(root, "packages/agent-framework/src/runtime/invariants.spec.ts");
const failures = [];

/** 从指定下标处的 { 开始做大括号配对，返回配对 } 的下标。 */
function matchBrace(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

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

    // 门 2 核心：从 cases 的每条 legacy 断言体提取块，验证哨兵 + 至少一个关键词命中对应块。
    // CR-39 修复后 legacy/plugin 两版各自内联断言，不再共享 CHECKS 集合；
    // 门改为扫描 cases 中每条 pair() 的 legacy 断言体（第一个 async 箭头函数）。
    const casesStart = source.indexOf("const cases");
    if (casesStart === -1) {
      failures.push("找不到 cases 断言集合");
    } else {
      const casesBody = source.slice(casesStart);
      const blockPattern = /pair\((\d+),\s*INVARIANT_NAMES\[\d+\],\s*async\s*\(\)\s*=>\s*\{/g;
      const blocks = new Map();
      for (const match of casesBody.matchAll(blockPattern)) {
        const id = Number(match[1]);
        const braceIndex = casesBody.indexOf("{", match.index + match[0].length - 1);
        const blockEnd = matchBrace(casesBody, braceIndex);
        if (blockEnd === -1) {
          failures.push(`断言块 #${id} 大括号未配对`);
          continue;
        }
        blocks.set(id, casesBody.slice(braceIndex + 1, blockEnd));
      }
      for (let id = 1; id <= 12; id += 1) {
        const entry = found.get(id);
        const block = blocks.get(id);
        if (entry === undefined || block === undefined) {
          failures.push(`要点 #${id} 找不到对应的断言块`);
          continue;
        }
        // 哨兵（assertFragment）必须出现在该断言块中，证明触发条件被真实断言。
        if (!block.includes(entry.fragment)) {
          failures.push(`要点 #${id} 的哨兵 "${entry.fragment}" 未命中断言块`);
        }
        // 至少一个要点关键词必须命中该断言块（大小写不敏感）。
        const lowered = block.toLowerCase();
        const hit = entry.keywords.some((kw) => lowered.includes(kw.toLowerCase()));
        if (!hit) {
          failures.push(`要点 #${id} 的关键词 [${entry.keywords.join(", ")}] 均未命中断言块`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error("要点关键词门失败：");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("要点关键词门通过：12 条要点映射表齐全，哨兵与关键词均命中对应断言块");
