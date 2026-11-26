import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bun = "bun";

const aggregates = [
  ["components", ["createEffectHost", "createEventBus", "createSeam", "createLogger"]],
  ["agent-components", ["createAgent", "createEventStream", "createInbox"]],
];

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
  else console.log("PASS", message);
}

for (const [pkg, expected] of aggregates) {
  const probe = join(root, "packages", pkg, "__aggregate_probe__.mjs");
  const body = [
    `const m = await import(${JSON.stringify(`@zeta-agent/${pkg}`)});`,
    `console.log("EXPORT_COUNT " + Object.keys(m).length);`,
    `for (const name of ${JSON.stringify(expected)}) {`,
    `  if (!(name in m)) { console.log("MISSING " + name); process.exitCode = 1; }`,
    `  else console.log("OK " + name);`,
    `}`,
  ].join("\n");
  writeFileSync(probe, `${body}\n`);
  try {
    const r = spawnSync(bun, [probe], {
      cwd: join(root, "packages", pkg),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    console.log(`\n--- aggregate @zeta-agent/${pkg} (exit=${r.status}) ---`);
    check(r.status === 0, `@zeta-agent/${pkg} 有非空聚合导出且含稳定 API`);
  } finally {
    unlinkSync(probe);
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
