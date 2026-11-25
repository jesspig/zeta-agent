import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, setDefaultTimeout, test } from "bun:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const entry = resolve(here, "index.ts");
const preload = resolve(here, "__fixtures__/reject-opentui-preload.ts");

setDefaultTimeout(30_000);

function run(args: readonly string[], input = "") {
  const env = { ...process.env };
  delete env.ZETA_BASE_URL;
  delete env.ZETA_API_KEY;
  delete env.ZETA_MODEL;
  return spawnSync(process.execPath, ["--preload", preload, entry, ...args], {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    timeout: 25_000,
  });
}

function expectNoOpenTui(result: ReturnType<typeof run>): void {
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain("HEADLESS_IMPORTED_OPENTUI");
}

test("headless 帮助模式不加载 OpenTUI", () => {
  const result = run(["--help"]);
  expectNoOpenTui(result);
  expect(result.stdout).toContain("zeta");
});

test("headless print 模式不加载 OpenTUI 并输出缺配置诊断", () => {
  const result = run(["--headless", "hello"]);
  expectNoOpenTui(result);
  expect(result.stdout).toContain("[echo] hello");
  expect(result.stderr).toContain("ZETA_BASE_URL");
});

test("headless json 模式不加载 OpenTUI 且每行可解析", () => {
  const result = run(["--json", "hello"]);
  expectNoOpenTui(result);
  const frames = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  expect(frames.every((frame) => typeof frame.type === "string")).toBe(true);
});

test("headless rpc 模式不加载 OpenTUI 且响应可解析", () => {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt", params: { text: "hello" } });
  const result = run(["--rpc"], `${request}\n`);
  expectNoOpenTui(result);
  const frame = JSON.parse(result.stdout.trim());
  expect(frame.id).toBe(1);
  expect(frame.result).toBeDefined();
});
