import { describe, expect, test } from "bun:test";
import { filterProcessEnv, DEFAULT_DENIED_ENV_KEYS, MINIMAL_ENV_ALLOWLIST } from "./env";
import { createNodeProcessLauncher } from "./launcher";

describe("统一进程 seam", () => {
  test("deny 模式剥离敏感键并保留普通键", () => {
    const env = filterProcessEnv({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "secret",
      CUSTOM: "keep",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CUSTOM).toBe("keep");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(DEFAULT_DENIED_ENV_KEYS).toContain("GITHUB_TOKEN");
  });

  test("allowlist 模式只保留白名单键，且不继承 NODE_OPTIONS", () => {
    const env = filterProcessEnv(
      { PATH: "/usr/bin", NODE_OPTIONS: "--require evil", SECRET: "x", SystemRoot: "C:\\Windows" },
      { allowlist: MINIMAL_ENV_ALLOWLIST },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.SECRET).toBeUndefined();
  });

  test("默认 node launcher 执行真实 argv 并收集 stdout", async () => {
    const launcher = createNodeProcessLauncher();
    const child = launcher.launch({
      command: process.execPath,
      args: ["-e", "process.stdout.write('seam-ok')"],
      stdio: { stdin: "ignore" },
    });
    let output = "";
    if (child.stdout !== null) {
      for await (const chunk of child.stdout) output += String(chunk);
    }
    expect(await child.exited).toBe(0);
    expect(output).toContain("seam-ok");
    expect(launcher.confinement).toBe("none");
  });
});
