import { describe, expect, test } from "bun:test";
import {
  createApprovalBroker,
  type ApprovalChannel,
  type ApprovalReply,
  type ApprovalRequest,
} from "./approval";

function request(id: string, timeoutMs?: number): ApprovalRequest {
  return { requestId: id, stage: "plan", tool: "probe", args: {}, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

function reply(req: ApprovalRequest, state: ApprovalReply["state"], replyId = "r-1"): ApprovalReply {
  return { requestId: req.requestId, replyId, state };
}

describe("T-08 four-state approval with request/reply IDs", () => {
  test("allowed-once approves a single use and rejects replay of the same request id", async () => {
    const channel: ApprovalChannel = {
      async request(req) {
        return reply(req, "allowed-once");
      },
    };
    const broker = createApprovalBroker(channel);
    const first = await broker.request(request("req-1"));
    expect(first.state).toBe("allowed-once");
    expect(first.allowed).toBe(true);
    const replay = await broker.request(request("req-1"));
    expect(replay.state).toBe("unavailable");
    expect(replay.allowed).toBe(false);
  });

  test("rejected is fail-closed", async () => {
    const broker = createApprovalBroker({ request: async (req) => reply(req, "rejected") });
    const decision = await broker.request(request("req-reject"));
    expect(decision.state).toBe("rejected");
    expect(decision.allowed).toBe(false);
  });

  test("abort yields cancelled and fail-closed", async () => {
    const broker = createApprovalBroker({
      request: (req) => new Promise<ApprovalReply>((resolve) => setTimeout(() => resolve(reply(req, "allowed-once")), 50)),
    });
    const controller = new AbortController();
    const pending = broker.request(request("req-cancel"), controller.signal);
    controller.abort();
    const decision = await pending;
    expect(decision.state).toBe("cancelled");
    expect(decision.allowed).toBe(false);
  });

  test("missing channel and timeout yield unavailable", async () => {
    const missing = await createApprovalBroker(undefined).request(request("req-none"));
    expect(missing.state).toBe("unavailable");
    expect(missing.allowed).toBe(false);

    const broker = createApprovalBroker({
      request: (req) => new Promise<ApprovalReply>((resolve) => setTimeout(() => resolve(reply(req, "allowed-once")), 50)),
    });
    const decision = await broker.request(request("req-timeout", 5));
    expect(decision.state).toBe("unavailable");
  });

  test("mismatched or empty IDs are unavailable", async () => {
    const mismatch = createApprovalBroker({ request: async () => reply(request("other"), "allowed-once") });
    expect((await mismatch.request(request("req-mismatch"))).state).toBe("unavailable");
    const empty = createApprovalBroker({ request: async (req) => reply(req, "allowed-once", "") });
    expect((await empty.request(request("req-empty"))).state).toBe("unavailable");
  });
});
