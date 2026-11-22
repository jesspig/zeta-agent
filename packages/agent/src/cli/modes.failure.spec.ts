import { describe, expect, test } from "bun:test";
import { createAgent } from "../facade";
import { MODES, detectRunError } from "./modes";

/** CR-09：模型/工具失败必须以非零退出码与结构化错误暴露，不能伪装成功。 */
describe("T-09 非交互失败语义", () => {
  test("detectRunError 识别 facade 编码的 Error 消息", () => {
    expect(detectRunError([{ role: "assistant", content: "Error: OPENAI_HTTP_401 (请检查 ZETA_API_KEY)" }])).toBe(true);
    expect(detectRunError([{ role: "assistant", content: "正常回答" }])).toBe(false);
  });

  test("print 模式遇到失败返回非零退出码", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        throw new Error("OPENAI_HTTP_401");
      },
    });
    const lines: string[] = [];
    const code = await MODES.print.run(agent, {
      prompt: "hi",
      output: (line) => lines.push(line),
    });
    expect(code).not.toBe(0);
  });

  test("RPC 遇到失败返回 error 帧而非 result", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        throw new Error("OPENAI_HTTP_401");
      },
    });
    const lines: string[] = [];
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt", params: { text: "hi" } });
    await MODES.rpc.run(agent, { lines: [request], output: (l) => lines.push(l) });
    const frame = JSON.parse(lines.at(-1) ?? "{}");
    expect(frame.error).toBeDefined();
    expect(frame.result).toBeUndefined();
  });
});
