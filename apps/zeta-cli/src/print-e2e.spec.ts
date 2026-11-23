import { expect, test } from "bun:test";
import {
  createAgent,
  decodeRpcFrame,
  encodeRpcRequest,
  MODES,
  type AgentStreamFn,
} from "@zeta-agent/agent";

test("U-11 端到端：提示词经 agent 流式转换为 print 输出", async () => {
  const streamFn: AgentStreamFn = async function* (request) {
    const last = request.messages.at(-1);
    const text = String(last?.content ?? "");
    yield `echo:${text}`;
  };
  const agent = createAgent({ streamFn });
  const output: string[] = [];
  const code = await MODES.print.run(agent, {
    prompt: "hello e2e",
    output: (line) => { output.push(line); },
  });
  expect(code).toBe(0);
  expect(output).toContain("user: hello e2e");
  expect(output).toContain("assistant: echo:hello e2e");
});

test("A12 json 端到端：无 TTY 下 exit 0 且每行输出可解析", async () => {
  const streamFn: AgentStreamFn = async function* (request) {
    const last = request.messages.at(-1);
    yield `json-echo:${String(last?.content ?? "")}`;
  };
  const agent = createAgent({ streamFn });
  const output: string[] = [];
  const code = await MODES.json.run(agent, {
    prompt: "hello json",
    output: (line) => { output.push(line); },
    tty: false,
  });

  expect(code).toBe(0);
  expect(output.length).toBeGreaterThan(0);
  const frames = output.map((line) => JSON.parse(line) as { type?: unknown });
  expect(frames.every((frame) => typeof frame.type === "string")).toBe(true);
  expect(frames.some((frame) => frame.type === "message_end")).toBe(true);
});

test("A12 rpc 端到端：无 TTY 下 exit 0 且响应帧可解析", async () => {
  const streamFn: AgentStreamFn = async function* (request) {
    const last = request.messages.at(-1);
    yield `rpc-echo:${String(last?.content ?? "")}`;
  };
  const agent = createAgent({ streamFn });
  const request = encodeRpcRequest({ id: 9, method: "prompt", params: { text: "hello rpc" } });
  const output: string[] = [];
  const code = await MODES.rpc.run(agent, {
    lines: [request],
    output: (line) => { output.push(line); },
    tty: false,
  });

  expect(code).toBe(0);
  expect(output).toHaveLength(1);
  const frame = decodeRpcFrame(output[0] ?? "");
  expect(frame.jsonrpc).toBe("2.0");
  expect(frame.id).toBe(9);
  expect(frame.result).toBeDefined();
});
