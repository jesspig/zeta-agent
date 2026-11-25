import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = "node";
const bun = "bun";

const facades = {
  framework: ["./types", "./context", "./events", "./observability", "./loader", "./objects", "./package.json"],
  "agent-framework": [
    "./types", "./runtime/agent", "./runtime/loop", "./session/surface",
    "./tools/pipeline", "./plugins/manager", "./plugins/hook-chain",
  ],
  agent: ["./facade", "./cli/modes", "./providers/openai", "./providers/openai-responses", "./providers/model-discovery", "./providers/models-dev", "./providers/model-catalog"],
  tui: ["./slots", "./signal", "./virtual", "./hud", "./frame-state", "./backend", "./runtime"],
  components: [],
  "agent-components": [],
  deploy: [],
  testing: [],
};

const failures = [];
const passed = [];

function check(condition, message) {
  if (condition) passed.push(message);
  else failures.push(message);
}

for (const [name, subpaths] of Object.entries(facades)) {
  const pkgDir = join(root, "packages", name);
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  check(pkg.exports !== undefined, `${name}: 声明显式 exports`);
  if (pkg.exports === undefined) continue;
  check(Object.hasOwn(pkg.exports, "."), `${name}: exports 含 "."`);
  check(Object.hasOwn(pkg.exports, "./package.json"), `${name}: exports 含 "./package.json"`);

  for (const [key, target] of Object.entries(pkg.exports)) {
    check(typeof target === "string", `${name}: exports "${key}" 为字符串目标`);
    if (typeof target === "string") {
      check(existsSync(resolve(pkgDir, target)), `${name}: exports "${key}" 目标存在 (${target})`);
    }
  }
  for (const subpath of subpaths) {
    check(Object.hasOwn(pkg.exports, subpath), `${name}: exports 声明稳定子路径 "${subpath}"`);
  }

  const probe = join(pkgDir, "__facade_resolve__.mjs");
  const pkgName = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).name;
  const script = [
    `for (const sub of ${JSON.stringify(subpaths)}) {`,
    `  try {`,
    `    const url = import.meta.resolve(${JSON.stringify(pkgName)} + sub.slice(1), import.meta.url);`,
    `    console.log("RESOLVE " + sub + " " + url);`,
    `  } catch (e) {`,
    `    console.log("FAIL " + sub + " " + String(e.message).split("\\n")[0]);`,
    `    process.exitCode = 1;`,
    `  }`,
    `}`,
  ].join("\n");
  writeFileSync(probe, `${script}\n`);
  try {
    const r = spawnSync(node, [probe], { cwd: pkgDir, encoding: "utf8" });
    if (subpaths.length > 0) {
      console.log(`\n--- exports resolve @ ${name} (exit=${r.status}) ---\n${(r.stdout + r.stderr).trim()}`);
      check(r.status === 0, `${name}: 所有声明子路径可被 Node 解析`);
    }
  } finally {
    unlinkSync(probe);
  }
}

// [consumer, specifiers, 期望命名导出映射]：不仅验证路径可解析，还验证实际导入与关键命名导出。
const importChecks = [
  ["agent", [
    "@zeta-agent/framework", "@zeta-agent/framework/types", "@zeta-agent/framework/context",
    "@zeta-agent/framework/events", "@zeta-agent/framework/observability",
    "@zeta-agent/framework/package.json",
    "@zeta-agent/agent/providers/openai-responses", "@zeta-agent/agent/providers/model-discovery",
    "@zeta-agent/agent/providers/models-dev", "@zeta-agent/agent/providers/model-catalog",
  ], {
    "@zeta-agent/framework": ["createContext", "defineKey", "defineRegistry", "createEventBus", "createEffectBridge"],
    "@zeta-agent/framework/context": ["createContext", "CONTEXT_DISPOSED"],
    "@zeta-agent/framework/events": ["createEventBus"],
    "@zeta-agent/framework/observability": ["createLogger", "createEffectBridge"],
    "@zeta-agent/agent/providers/openai-responses": ["createOpenAiResponsesStreamFn"],
    "@zeta-agent/agent/providers/model-discovery": ["fetchModelIds"],
    "@zeta-agent/agent/providers/model-catalog": ["decorateModels"],
  }],
  ["agent-framework", [
    "@zeta-agent/agent-framework", "@zeta-agent/agent-framework/tools/pipeline",
    "@zeta-agent/agent-framework/runtime/loop", "@zeta-agent/agent-framework/plugins/manager",
    "@zeta-agent/framework/types", "@zeta-agent/cordis", "@zeta-agent/events",
  ], {
    // 真插件管线边界：根导出 + 工具子路径 + 插件管理器子路径都必须暴露可用实现。
    "@zeta-agent/agent-framework": [
      "createAgent", "AgentPlugin", "AgentPluginManager", "createAgentPluginManager", "HookChain",
      "runLoop", "RUN_LOOP_STEPS", "runToolCall", "declareToolChanges", "createToolPipeline",
    ],
    "@zeta-agent/agent-framework/tools/pipeline": ["runToolCall", "declareToolChanges", "createToolPipeline"],
    "@zeta-agent/agent-framework/runtime/loop": ["runLoop", "RUN_LOOP_STEPS"],
    "@zeta-agent/agent-framework/plugins/manager": ["AgentPluginManager", "createAgentPluginManager"],
  }],
  ["tui", ["@zeta-agent/agent/facade", "@zeta-agent/agent", "@zeta-agent/tui/backend"], {
    "@zeta-agent/agent/facade": ["createAgent"],
  }],
];

for (const [consumerDir, specifiers, expectedExports] of importChecks) {
  const probe = join(root, "packages", consumerDir, "__facade_probe__.mjs");
  const lines = specifiers.map((spec) => {
    const names = expectedExports[spec] ?? [];
    const checks = names.map((n) => `if (!(${JSON.stringify(n)} in mod)) { console.log("MISSING_EXPORT " + ${JSON.stringify(spec)} + " " + ${JSON.stringify(n)}); process.exitCode = 1; }`).join(" ");
    return `try { const mod = await import(${JSON.stringify(spec)}); ${checks} console.log("OK " + ${JSON.stringify(spec)}); } ` +
      `catch (e) { console.log("FAIL " + ${JSON.stringify(spec)} + " " + String(e.message).split("\\n")[0]); process.exitCode = 1; }`;
  });
  writeFileSync(probe, `${lines.join("\n")}\n`);
  try {
    const r = spawnSync(bun, [probe], {
      cwd: join(root, "packages", consumerDir),
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    console.log(`\n--- import smoke @ packages/${consumerDir} (exit=${r.status}) ---\n${(r.stdout + r.stderr).trim()}`);
    check(r.status === 0, `packages/${consumerDir}: facade 子路径动态导入全部成功`);
  } finally {
    unlinkSync(probe);
  }
}

console.log("\n===== 汇总 =====");
for (const line of passed) console.log("PASS", line);
for (const line of failures) console.log("FAIL", line);
if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
