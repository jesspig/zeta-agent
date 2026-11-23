// 要点关键词门（门 2）+ T-04 新边界门：
// 校验 invariants.spec.ts 的 INVARIANT_TEST_POINTS 映射表，验证每条 §13 要点的
// legacy/plugin 两版断言块都命中哨兵与关键词，并验证 plugin 版由真 AgentPluginManager
// 驱动（不再 decision 字段赋值）、三条假阳性修复（#6/#11/#12）确实落地。
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

/** 扫描正文里所有 async () => { ... } 块，返回起始下标与块内容。 */
function asyncBlocks(body) {
  const blocks = [];
  const pattern = /async\s*\(\)\s*=>\s*\{/g;
  for (const match of body.matchAll(pattern)) {
    const braceIndex = body.indexOf("{", match.index + match[0].length - 1);
    const end = matchBrace(body, braceIndex);
    if (end === -1) continue;
    blocks.push({ start: match.index, body: body.slice(braceIndex + 1, end) });
  }
  return blocks;
}

function functionBody(source, name) {
  const index = source.indexOf(`function ${name}(`);
  if (index === -1) return undefined;
  // 参数默认值里有 {}，需先定位参数表结束的 ") {" 再取函数体起始大括号。
  const marker = source.indexOf(") {", index);
  if (marker === -1) return undefined;
  const braceIndex = source.indexOf("{", marker);
  const end = matchBrace(source, braceIndex);
  return end === -1 ? undefined : source.slice(braceIndex + 1, end);
}

function hitKeyword(block, keywords) {
  const lowered = block.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

if (!existsSync(spec)) {
  failures.push(`找不到断言文件：${spec}`);
} else {
  const source = readFileSync(spec, "utf8");

  // ---- 门 1：映射表齐全、字段非空（保留原强度并新增 pluginFragment） ----
  const tableStart = source.indexOf("INVARIANT_TEST_POINTS");
  if (tableStart === -1) {
    failures.push("缺少 INVARIANT_TEST_POINTS 映射表");
  } else {
    const afterTable = source.slice(tableStart);
    const entryPattern =
      /(\d+):\s*\{[^}]*?point:\s*"([^"]*)"[^}]*?keywords:\s*\[([^\]]*)\][^}]*?assertFragment:\s*"([^"]*)"[^}]*?pluginFragment:\s*"([^"]*)"/g;
    const found = new Map();
    for (const match of afterTable.matchAll(entryPattern)) {
      const id = Number(match[1]);
      if (found.has(id)) failures.push(`映射表条目 #${id} 重复`);
      const keywords = match[3]
        .split(",")
        .map((part) => part.trim().replace(/^["']|["']$/g, ""))
        .filter((part) => part.length > 0);
      found.set(id, { point: match[2], keywords, fragment: match[4], pluginFragment: match[5] });
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
      if (entry.pluginFragment.length === 0) failures.push(`要点 #${id} 没有 pluginFragment`);
    }
    if (found.size !== 12) failures.push(`映射表条目数应为 12，实际 ${found.size}`);

    // ---- 门 2：两版断言块各自的哨兵 + 关键词 + 本版接线哨兵/构造器 ----
    const casesStart = source.indexOf("const cases");
    if (casesStart === -1) {
      failures.push("找不到 cases 断言集合");
    } else {
      const casesBody = source.slice(casesStart);
      const blocks = asyncBlocks(casesBody);
      const pairs = new Map();
      const pairPattern = /pair\((\d+),\s*INVARIANT_NAMES\[\d+\]/g;
      for (const match of casesBody.matchAll(pairPattern)) {
        const following = blocks.filter((block) => block.start > match.index).slice(0, 2);
        pairs.set(Number(match[1]), {
          legacy: following[0]?.body,
          plugin: following[1]?.body,
        });
      }
      for (let id = 1; id <= 12; id += 1) {
        const entry = found.get(id);
        const pair = pairs.get(id);
        if (entry === undefined || pair?.legacy === undefined || pair.plugin === undefined) {
          failures.push(`要点 #${id} 找不到对应的两版断言块`);
          continue;
        }
        // 旧门强度保留：legacy 块的哨兵与关键词必须命中。
        if (!pair.legacy.includes(entry.fragment)) {
          failures.push(`要点 #${id} 的哨兵 "${entry.fragment}" 未命中 legacy 断言块`);
        }
        if (!hitKeyword(pair.legacy, entry.keywords)) {
          failures.push(`要点 #${id} 的关键词 [${entry.keywords.join(", ")}] 均未命中 legacy 断言块`);
        }
        // 新门：plugin 块同样必须命中哨兵与关键词，不得只靠 legacy 版凑数。
        if (!pair.plugin.includes(entry.pluginFragment)) {
          failures.push(`要点 #${id} 的哨兵 "${entry.pluginFragment}" 未命中 plugin 断言块`);
        }
        if (!hitKeyword(pair.plugin, entry.keywords)) {
          failures.push(`要点 #${id} 的关键词 [${entry.keywords.join(", ")}] 均未命中 plugin 断言块`);
        }
        // 本版接线哨兵必须命中，且不得跨版调用对方的构造器。
        // 纯工具/静态扫描要点（#8/#9/#10/#12）不构造 runtime，故构造器检查按"出现即正确"处理。
        if (!pair.legacy.includes("legacyHookProbe")) {
          failures.push(`要点 #${id} 的 legacy 块未调用本版接线哨兵`);
        }
        if (!pair.plugin.includes("pluginHookProbe")) {
          failures.push(`要点 #${id} 的 plugin 块未调用本版接线哨兵`);
        }
        if (pair.legacy.includes("makePluginRuntime") || pair.plugin.includes("makeLegacyRuntime")) {
          failures.push(`要点 #${id} 的两版构造器交叉调用`);
        }
        if (pair.plugin.includes("decision:")) {
          failures.push(`要点 #${id} 的 plugin 块仍含 decision 字段赋值`);
        }
      }

      const sixth = pairs.get(6);
      if (sixth !== undefined) {
        for (const mode of ["legacy", "plugin"]) {
          const block = sixth[mode] ?? "";
          if (!block.includes("throw") || !block.includes("agent_end")) {
            failures.push(`要点 #6 ${mode} 版未验证抛错 hook 由 runLoop 归一化`);
          }
        }
      }
      const eleventh = pairs.get(11);
      if (eleventh !== undefined) {
        for (const mode of ["legacy", "plugin"]) {
          const block = eleventh[mode] ?? "";
          if (!block.includes("runToolCall")) {
            failures.push(`要点 #11 ${mode} 版未使用 runToolCall`);
          }
          if (block.includes("toBe(before + 2)")) {
            failures.push(`要点 #11 ${mode} 版仍保留与不变量相反的消息追加断言`);
          }
        }
      }
      const twelfth = pairs.get(12);
      if (twelfth !== undefined) {
        for (const mode of ["legacy", "plugin"]) {
          const block = twelfth[mode] ?? "";
          if (!block.includes("declareToolChanges")) {
            failures.push(`要点 #12 ${mode} 版未使用 declareToolChanges`);
          }
          if (/\breduceState\s*\(/.test(block)) {
            failures.push(`要点 #12 ${mode} 版仍手工调用 reduceState`);
          }
        }
      }
    }

    // ---- 新边界：plugin 构造器必须由 AgentPluginManager 驱动 ----
    const pluginCtor = functionBody(source, "makePluginRuntime") ?? "";
    const legacyCtor = functionBody(source, "makeLegacyRuntime") ?? "";
    for (const needle of ["new AgentPluginManager", "addHook", "manager.run"]) {
      if (!pluginCtor.includes(needle)) {
        failures.push(`plugin 构造器缺少真插件管线要素 "${needle}"`);
      }
    }
    if (!legacyCtor.includes("finishTurn")) {
      failures.push("legacy 构造器未保留 finishTurn 字段赋值");
    }
    if (legacyCtor.includes("AgentPluginManager")) {
      failures.push("legacy 构造器不应实例化 AgentPluginManager");
    }
    if (source.includes("decision: options.decisionPlugin")) {
      failures.push("仍存在 decision 字段赋值的旧 plugin 入口");
    }
  }
}

if (failures.length > 0) {
  console.error("要点关键词门失败：");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("要点关键词门通过：12 条要点两版哨兵/关键词齐全，真插件管线与三条假阳性修复已校验");
