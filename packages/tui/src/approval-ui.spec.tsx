import { expect, test } from "bun:test";
import { createApprovalBroker, type ApprovalChannel } from "@zeta-agent/agent";
import { testRender } from "@opentui/solid";
import { createApprovalUiChannel, ApprovalOverlay } from "./approval-ui";

function request(id: string): Parameters<ApprovalChannel["request"]>[0] {
  return { requestId: id, stage: "plan", tool: "write", args: { path: "x" }, reason: "需审批" };
}

test("TUI 审批 UI 与 headless/RPC 共享 ApprovalChannel 与四态 broker", async () => {
  const ui = createApprovalUiChannel();
  const tuiBroker = createApprovalBroker(ui.channel);
  const rpcBroker = createApprovalBroker(ui.channel);

  const fromTui = tuiBroker.request(request("req-tui"));
  expect(ui.pending()?.requestId).toBe("req-tui");
  ui.respond("allowed-once");
  const tuiDecision = await fromTui;
  expect(tuiDecision.allowed).toBe(true);
  expect(tuiDecision.state).toBe("allowed-once");
  expect(tuiDecision.replyId?.length).toBeGreaterThan(0);

  const fromRpc = rpcBroker.request(request("req-rpc"));
  expect(ui.pending()?.requestId).toBe("req-rpc");
  ui.respond("rejected");
  const rpcDecision = await fromRpc;
  expect(rpcDecision.allowed).toBe(false);
  expect(rpcDecision.state).toBe("rejected");
});

test("ApprovalOverlay 渲染待审批请求并支持键盘允许/拒绝", async () => {
  const ui = createApprovalUiChannel();
  const broker = createApprovalBroker(ui.channel);
  const decided: string[] = [];
  const pending = broker.request(request("req-overlay")).then((decision) => {
    decided.push(decision.state);
    return decision;
  });

  const setup = await testRender(() => <ApprovalOverlay channel={ui} />, { width: 40, height: 5 });
  try {
    await setup.waitForFrame((frame) => frame.includes("需审批"));
    setup.mockInput.pressKey("y" as never);
    await setup.waitForFrame(() => decided.length === 1);
    expect(await pending).toMatchObject({ state: "allowed-once", requestId: "req-overlay" });
  } finally {
    setup.renderer.destroy();
  }
});
