import { describe, expect, test } from "bun:test";
import {
  encodeControlFrame,
  type ControlFrame,
  type ControlResult,
  type RuntimeProtocol,
} from "@zeta-agent/agent";
import {
  createMemorySessionControl,
  createRpcDispatcher,
  RPC_METHODS,
  type ApprovalSeam,
  type RpcRequest,
  type RpcRuntime,
} from "./rpc";

const REQUIRED_METHODS = [
  "prompt",
  "steer",
  "followUp",
  "cancel",
  "approve",
  "session.load",
  "session.fork",
  "session.resume",
  "session.compact",
  "readiness",
  "liveness",
  "configDigest",
  "health",
];

function request(id: number, method: string, params?: Record<string, unknown>): RpcRequest {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function makeRuntime(): { runtime: RpcRuntime; frames: ControlFrame[]; approvals: string[] } {
  const frames: ControlFrame[] = [];
  const approvals: string[] = [];
  const dispatch = async (frame: ControlFrame): Promise<ControlResult> => {
    frames.push(frame);
    return { type: "control.result", ok: true, action: frame.action };
  };
  const protocol: RuntimeProtocol = {
    session: { id: "session-1", messages: () => [], reset: () => {} },
    control: { dispatch },
    event: { subscribe: () => () => {} },
    dispatch,
  };
  const approval: ApprovalSeam = {
    async request(next) {
      approvals.push(next.requestId);
      return { requestId: next.requestId, replyId: `reply-${next.requestId}`, state: "allowed-once" };
    },
  };
  return {
    runtime: {
      protocol,
      probes: {
        readiness: () => true,
        liveness: () => true,
        configDigest: () => "digest-1",
      },
      session: createMemorySessionControl(),
      approval,
    },
    frames,
    approvals,
  };
}

describe("T-21 RPC 全控制面", () => {
  test("声明全部必需方法并拒绝未知方法", async () => {
    for (const method of REQUIRED_METHODS) expect(RPC_METHODS as readonly string[]).toContain(method);
    const { runtime } = makeRuntime();
    const dispatcher = createRpcDispatcher(runtime);
    const response = await dispatcher.handle(request(1, "does.not.exist"));
    expect(response.error?.code).toBe(-32601);
  });

  test("prompt/steer/followUp/cancel 投影到 T-10 control 帧", async () => {
    const { runtime, frames } = makeRuntime();
    const dispatcher = createRpcDispatcher(runtime);
    await dispatcher.handle(request(1, "prompt", { text: "hello" }));
    await dispatcher.handle(request(2, "steer", { message: { role: "user", content: "steer" } }));
    await dispatcher.handle(request(3, "followUp", { message: { role: "user", content: "later" } }));
    await dispatcher.handle(request(4, "cancel"));
    expect(frames.map((frame) => frame.action)).toEqual(["prompt", "steer", "followUp", "abort"]);
    expect(frames[0]).toEqual(encodeControlFrame({ action: "prompt", text: "hello" }));
  });

  test("approve 复用 T-14 四态审批通道，重放被拒且无通道 fail-closed", async () => {
    const { runtime, approvals } = makeRuntime();
    const dispatcher = createRpcDispatcher(runtime);
    const first = await dispatcher.handle(request(1, "approve", { requestId: "req-1", stage: "plan", tool: "bash", args: {} }));
    expect(first.result).toMatchObject({ state: "allowed-once", allowed: true });
    const replay = await dispatcher.handle(request(2, "approve", { requestId: "req-1", stage: "plan", tool: "bash", args: {} }));
    expect(replay.result).toMatchObject({ allowed: false });
    expect(approvals).toEqual(["req-1"]);

    const withoutChannel = createRpcDispatcher({ ...runtime, approval: undefined });
    const denied = await withoutChannel.handle(request(3, "approve", { requestId: "req-2", tool: "bash", args: {} }));
    expect(denied.result).toMatchObject({ state: "unavailable", allowed: false });
  });

  test("session load/fork/resume/compact 全部可用", async () => {
    const { runtime } = makeRuntime();
    const dispatcher = createRpcDispatcher(runtime);
    const loaded = await dispatcher.handle(request(1, "session.load", { sessionId: "s1" }));
    expect(loaded.result).toMatchObject({ sessionId: "s1" });
    const forked = await dispatcher.handle(request(2, "session.fork", { frameId: "f1" }));
    expect(forked.result).toMatchObject({ from: "f1" });
    const resumed = await dispatcher.handle(request(3, "session.resume", { frameId: "f2" }));
    expect(resumed.result).toMatchObject({ frameId: "f2" });
    const compacted = await dispatcher.handle(request(4, "session.compact", { sessionId: "s1" }));
    expect(compacted.result).toMatchObject({ compacted: true });
  });

  test("readiness/liveness/configDigest/health 走探针与健康汇总", async () => {
    const { runtime } = makeRuntime();
    const dispatcher = createRpcDispatcher(runtime);
    expect((await dispatcher.handle(request(1, "readiness"))).result).toBe(true);
    expect((await dispatcher.handle(request(2, "liveness"))).result).toBe(true);
    expect((await dispatcher.handle(request(3, "configDigest"))).result).toBe("digest-1");
    expect((await dispatcher.handle(request(4, "health"))).result).toMatchObject({
      ready: true,
      live: true,
      digest: "digest-1",
    });
  });

  test("非法参数返回 INVALID_PARAMS 而非抛穿", async () => {
    const { runtime } = makeRuntime();
    const dispatcher = createRpcDispatcher(runtime);
    const response = await dispatcher.handle(request(1, "prompt", {}));
    expect(response.error?.code).toBe(-32602);
  });
});
