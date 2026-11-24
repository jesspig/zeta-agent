import { expect, test } from "bun:test";
import {
  createSharedControlPlane,
  encodeControlFrame,
  type Agent,
  type ApprovalChannel,
} from "@zeta-agent/agent";
import { createApprovalUiChannel } from "./approval-ui";
import type { RuntimeProtocol } from "@zeta-agent/agent";

test("TUI 与 headless/RPC 共享 assembly 的 control plane 与 approval broker", async () => {
  const ui = createApprovalUiChannel();
  const agent = {
    state: { messages: [] },
    prompt: async () => [],
    waitForIdle: async () => {},
    subscribe: () => () => {},
    abort: () => {},
    reset: () => {},
  } as unknown as Agent;

  const plane = createSharedControlPlane(agent, ui.channel);
  const protocol: RuntimeProtocol = plane.protocol;
  expect(await protocol.control.dispatch(encodeControlFrame({ action: "abort" }))).toMatchObject({
    ok: true,
    action: "abort",
  });

  const pending = plane.approval.request({
    requestId: "shared-1",
    stage: "plan",
    tool: "write",
    args: {},
  });
  expect(ui.pending()?.requestId).toBe("shared-1");
  ui.respond("allowed-once");
  expect(await pending).toMatchObject({ allowed: true, state: "allowed-once", requestId: "shared-1" });
  expect(plane.approvalChannel).toBe(ui.channel);
});

test("共享装配入口允许 headless 通道替换 UI 通道", async () => {
  const rpcChannel: ApprovalChannel = {
    request: async (request) => ({
      requestId: request.requestId,
      replyId: "rpc-reply",
      state: "rejected",
    }),
  };
  const plane = createSharedControlPlane({} as Agent, rpcChannel);
  expect(
    await plane.approval.request({ requestId: "rpc-1", stage: "plan", tool: "write", args: {} }),
  ).toMatchObject({ allowed: false, state: "rejected", replyId: "rpc-reply" });
});
