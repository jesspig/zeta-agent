import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const reportsDir = join(root, "reports");
export const evidenceDir = join(reportsDir, "evidence");

export function run(command, args, options = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout,
    env: options.env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    code: result.status ?? -1,
    stdout,
    stderr,
    out: `${stdout}\n${stderr}`,
    durationMs: Math.round(performance.now() - started),
  };
}

export function writeJson(relativePath, value) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

export function writeGates(name, gates) {
  return writeJson(`reports/gates-${name}.json`, gates);
}

export function writeEvidence(id, text) {
  const target = join(evidenceDir, `${id}.txt`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
  return `reports/evidence/${id}.txt`;
}

export function readConfig() {
  const path = join(root, "quality-gates.config.json");
  if (!existsSync(path)) throw new Error(`CONFIG_MISSING: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function makeGate({
  id,
  category,
  name,
  status,
  scope = "local",
  detail,
  exitCode,
  durationMs,
  evidence = [],
}) {
  if (!["pass", "fail", "skipped", "unverified"].includes(status)) {
    throw new Error(`INVALID_STATUS: ${status}`);
  }
  return {
    id,
    category,
    name,
    status,
    scope,
    detail,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
    evidence,
  };
}

export function parseBunTestSummary(out) {
  const pass = /(\d+)\s+pass/.exec(out);
  const fail = /(\d+)\s+fail/.exec(out);
  const skip = /(\d+)\s+skip/.exec(out);
  const files = /Ran\s+\d+\s+tests across\s+(\d+)\s+files/.exec(out);
  if (!pass || !fail || !files) return null;
  return {
    pass: Number(pass[1]),
    fail: Number(fail[1]),
    skip: skip ? Number(skip[1]) : 0,
    files: Number(files[1]),
  };
}

/** 真实执行一组测试文件；任何非零退出或失败数都会让门失败，不降低阈值。 */
export function runTestGroup({ id, name, category, scope = "local", files, args = [] }) {
  if (files.length === 0) throw new Error(`EMPTY_TEST_GROUP: ${id}`);
  for (const file of files) {
    if (!existsSync(join(root, file))) throw new Error(`TEST_FILE_MISSING: ${file}`);
  }
  const result = run("bun", ["test", ...files, ...args]);
  const evidence = writeEvidence(id, `$ bun test ${files.join(" ")}\n[exit=${result.code}]\n${result.out}`);
  const summary = parseBunTestSummary(result.out);
  const status =
    result.code === 0 && summary !== null && summary.fail === 0 && summary.pass > 0
      ? "pass"
      : "fail";
  const detail =
    summary === null
      ? `无法解析测试汇总（exit=${result.code}）`
      : `${summary.pass} pass / ${summary.fail} fail / ${summary.skip} skip / ${summary.files} files，${result.durationMs}ms`;
  return makeGate({
    id,
    category,
    name,
    status,
    scope,
    detail,
    exitCode: result.code,
    durationMs: result.durationMs,
    evidence: [
      { kind: "command", ref: `bun test ${files.length} files` },
      { kind: "file", ref: evidence },
    ],
  });
}
