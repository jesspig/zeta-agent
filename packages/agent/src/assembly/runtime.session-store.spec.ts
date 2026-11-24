import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRuntime } from "./runtime";
import { createJsonlSessionStore } from "../session/jsonl-store";

const dirs: string[] = [];
function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-runtime-store-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function stubStream() {
  return async function* () {
    yield "ok";
  };
}

describe("T-11 默认装配的 SessionStore 注入", () => {
  test("显式注入 store 后复用 T-10 session 视图", async () => {
    const store = createJsonlSessionStore({ path: tempPath("injected.jsonl") });
    const runtime = await createDefaultRuntime({
      includeBuiltins: false,
      streamFn: stubStream(),
      sessionStore: store,
    });
    expect(runtime.sessionStore).toBe(store);
    const sessionService = runtime.services[runtime.manifest.session[0] ?? "session:store"] as {
      store?: unknown;
    };
    expect(sessionService.store).toBe(store);

    const result = await runtime.protocol.dispatch({
      type: "control",
      action: "prompt",
      text: "injected",
    });
    expect(result.ok).toBe(true);
    expect(store.projection().messages.map((item) => item.content)).toContain("injected");
    await runtime.dispose();
  });

  test("按路径创建 JSONL/SQLite 后端并落盘", async () => {
    for (const backend of ["jsonl", "sqlite"] as const) {
      const path = tempPath(`runtime.${backend}`);
      const runtime = await createDefaultRuntime({
        includeBuiltins: false,
        streamFn: stubStream(),
        sessionStorePath: path,
        sessionStoreBackend: backend,
        sessionId: `runtime-${backend}`,
      });
      expect(runtime.sessionStore).toBeDefined();
      const result = await runtime.protocol.dispatch({
        type: "control",
        action: "prompt",
        text: `via-${backend}`,
      });
      expect(result.ok, backend).toBe(true);
      expect(runtime.sessionStore?.projection().messages.map((item) => item.content)).toContain(
        `via-${backend}`
      );
      expect(runtime.sessionStore?.header.sessionId).toBe(`runtime-${backend}`);
      await runtime.dispose();
    }
  });
});
