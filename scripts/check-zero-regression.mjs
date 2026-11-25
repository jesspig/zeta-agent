import { spawnSync } from "node:child_process";

const argPass = process.argv.find((a) => a.startsWith("--pass="));
const argFiles = process.argv.find((a) => a.startsWith("--files="));
// T-12 收口基线：2026-11-21 全量验证 283 pass / 0 fail / 51 files。
// 下限保护：当前通过数/文件数不得低于基线，确保新增测试不掩盖回归。
const BASELINE = {
  pass: argPass ? Number(argPass.split("=")[1]) : 283,
  fail: 0,
  files: argFiles ? Number(argFiles.split("=")[1]) : 51,
};
const CORE_PACKAGES = [
  "@zeta-agent/cordis",
  "@zeta-agent/events",
  "@zeta-agent/agent-framework",
  "@zeta-agent/agent",
  "@zeta-agent/security",
  "@zeta-agent/observability",
  "@zeta-agent/deploy",
];

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exit(1);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

const bunTest = run("bun", ["test"]);
if (bunTest.code !== 0) {
  console.error(bunTest.out);
  fail(`bun test 退出码非 0: ${bunTest.code}`);
}

const passMatch = /(\d+)\s+pass/.exec(bunTest.out);
const failMatch = /(\d+)\s+fail/.exec(bunTest.out);
const filesMatch = /Ran\s+\d+\s+tests across\s+(\d+)\s+files/.exec(bunTest.out);
if (!passMatch || !failMatch || !filesMatch) {
  console.error(bunTest.out);
  fail("无法从 bun test 输出解析 pass/fail/files");
}

const current = {
  pass: Number(passMatch[1]),
  fail: Number(failMatch[1]),
  files: Number(filesMatch[1]),
};
console.log(`基线: ${BASELINE.pass} pass / ${BASELINE.fail} fail / ${BASELINE.files} files`);
console.log(`当前: ${current.pass} pass / ${current.fail} fail / ${current.files} files`);

if (current.fail !== 0) fail(`存在失败测试: ${current.fail}`);
if (current.pass < BASELINE.pass) fail(`通过数低于基线: ${current.pass} < ${BASELINE.pass}`);
if (current.files < BASELINE.files) fail(`测试文件数低于基线: ${current.files} < ${BASELINE.files}`);

const turboTest = run("bun", ["x", "turbo", "run", "test"]);
if (turboTest.code !== 0) {
  console.error(turboTest.out);
  fail(`turbo run test 退出码非 0: ${turboTest.code}`);
}
for (const pkg of CORE_PACKAGES) {
  if (!turboTest.out.includes(pkg)) {
    console.error(turboTest.out);
    fail(`turbo run test 输出缺少核心包: ${pkg}`);
  }
}

console.log("PASS 核心语义零回归：通过数/文件数不低于基线，核心包测试均存在且全绿");
