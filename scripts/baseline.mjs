import { spawnSync } from "node:child_process";

const steps = [
  ["install", ["bun", "install", "--frozen-lockfile"]],
  ["build", ["bun", "x", "turbo", "run", "build"]],
  ["typecheck", ["bun", "x", "turbo", "run", "typecheck"]],
  ["test", ["bun", "x", "turbo", "run", "test"]],
  ["tsc", ["bun", "x", "tsc", "--noEmit"]],
  ["bun-test", ["bun", "test"]],
];

if (process.argv.includes("--selfcheck")) {
  const r = spawnSync("bun", ["x", "this-command-does-not-exist-zeta-selfcheck"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  console.log(`selfcheck exit=${r.status ?? -1}（预期非零，证明脚本能捕获失败）`);
  process.exit(r.status === 0 ? 1 : 0);
}

const results = [];
for (const [name, cmd] of steps) {
  console.log(`\n===== [${name}] ${cmd.join(" ")} =====`);
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
  const code = r.status ?? -1;
  console.log(`----- [${name}] exit=${code} -----`);
  results.push({ name, code });
}

console.log("\n===== 汇总 =====");
for (const r of results) console.log(`${r.name}: ${r.code === 0 ? "PASS" : `FAIL(${r.code})`}`);
if (results.some((r) => r.code !== 0)) process.exit(1);
