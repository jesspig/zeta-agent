import { describe, expect, test } from "bun:test";
import { GRPC_STATUS } from "./remote";
import { createGrpcRemoteClient, createGrpcRemoteServer } from "./grpc";

describe("T-27 wire-level gRPC transport", () => {
  test("真实 gRPC unary 往返携带 token/代次并返回状态与结果", async () => {
    const server = await createGrpcRemoteServer(
      (request) => {
        if (request.generation !== 7) return { status: 9, error: "STALE_GENERATION" };
        return { status: GRPC_STATUS.OK, response: { method: request.method, echo: request.params?.value } };
      },
      "secret-token"
    );
    const client = createGrpcRemoteClient(server.address, { token: "secret-token", generation: 7 });
    try {
      expect(client.protoDigest).toBe(server.digest);
      const ok = await client.invoke("session.load", { value: 42 });
      expect(ok.status).toBe(GRPC_STATUS.OK);
      expect(ok.response).toEqual({ method: "session.load", echo: 42 });
      const staleClient = createGrpcRemoteClient(server.address, { token: "secret-token", generation: 8 });
      try {
        const stale = await staleClient.invoke("session.load", {});
        expect(stale.status).toBe(9);
        expect(stale.error).toBe("STALE_GENERATION");
      } finally {
        staleClient.close();
      }
    } finally {
      client.close();
      await server.close();
    }
  });

  test("错误 token 在 gRPC 层返回 UNAUTHENTICATED", async () => {
    const server = await createGrpcRemoteServer(() => ({ status: GRPC_STATUS.OK }), "right-token");
    const client = createGrpcRemoteClient(server.address, { token: "wrong-token" });
    try {
      const result = await client.invoke("readiness");
      expect(result.status).toBe(GRPC_STATUS.UNAUTHENTICATED);
    } finally {
      client.close();
      await server.close();
    }
  });
});
