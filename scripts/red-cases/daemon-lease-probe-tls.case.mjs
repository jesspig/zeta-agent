import { startDaemon } from "../../packages/deploy/src/daemon.ts";
import { createMemorySessionControl } from "../../packages/deploy/src/rpc.ts";
import { green, red } from "./common.mjs";

const EVIDENCE =
  "packages/deploy/src/daemon.ts（租约续期/readiness/HTTP 探针/TLS 传输门禁）、packages/deploy/src/control-lease.ts（续租状态机）";

function runtime(ready) {
  return {
    protocol: {
      session: { id: "red12-session", messages: () => [], reset: () => {} },
      control: { dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }) },
      event: { subscribe: () => () => {} },
      dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }),
    },
    probes: { readiness: () => ready, liveness: () => true, configDigest: () => "digest-red12" },
    session: createMemorySessionControl(),
  };
}

const BASE = { token: "red12-token", config: { target: "linux-x64", port: 0 } };

async function rpc(daemon, id) {
  const response = await fetch(`${daemon.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer red12-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "prompt", params: { text: "hello" } }),
  });
  return { status: response.status, body: await response.json() };
}

/** RED-12：daemon 租约/探针/TLS 三类关键失败的反例；只用 loopback 与假时钟，不访问外网。 */
export default {
  id: "RED-12-daemon-lease-probe-tls",
  title: "daemon 明文非 loopback 必须拒绝、未 ready 必须 503、租约 TTL 过期必须停止服务",
  expectation:
    "非 loopback 明文启动显式拒绝；readiness=false 时 /ready 返回 503；假时钟越过 TTL 后 readiness=false 且 RPC 返回 NOT_LEADER",
  target: "AC-16",
  async probe() {
    const actual = { nonLoopbackPlaintextRejected: false, readiness503: false, ttlExpiredStopsRpc: false };
    let nonLoopbackError = "";
    let readyStatus = 0;
    let expiredReady = null;
    let expiredCode = 0;

    try {
      startDaemon({
        ...BASE,
        runtime: runtime(true),
        host: "198.51.100.7",
        port: 0,
        ipcPort: 0,
        allowPlainLoopback: false,
      });
    } catch (error) {
      nonLoopbackError = error instanceof Error ? error.message : String(error);
      actual.nonLoopbackPlaintextRejected = nonLoopbackError.includes("TLS_REQUIRED");
    }

    const notReady = startDaemon({
      ...BASE,
      runtime: runtime(false),
      host: "127.0.0.1",
      port: 0,
      ipcPort: 0,
      allowPlainLoopback: true,
      leaseTtlMs: 1000,
    });
    try {
      readyStatus = (await fetch(`${notReady.url}/ready`)).status;
      actual.readiness503 = readyStatus === 503;
    } finally {
      await notReady.stop();
    }

    let now = 1000;
    const expiring = startDaemon({
      ...BASE,
      runtime: runtime(true),
      host: "127.0.0.1",
      port: 0,
      ipcPort: 0,
      allowPlainLoopback: true,
      now: () => now,
      leaseTtlMs: 100,
      leaseRenewMs: 0,
      heartbeatMs: 50,
    });
    try {
      now = 1400;
      expiredReady = expiring.readiness();
      const reply = await rpc(expiring, 12);
      expiredCode = reply.body?.error?.code ?? 0;
      actual.ttlExpiredStopsRpc = expiredReady === false && expiredCode === -32003;
    } finally {
      await expiring.stop();
    }

    const ok = actual.nonLoopbackPlaintextRejected && actual.readiness503 && actual.ttlExpiredStopsRpc;
    return ok
      ? green({ ...actual, nonLoopbackError, readyStatus, expiredReady, expiredCode }, EVIDENCE)
      : red(
          { ...actual, nonLoopbackError, readyStatus, expiredReady, expiredCode },
          "daemon 仍存在明文非 loopback 可启动、未 ready 返回 200、TTL 过期仍服务的失败路径",
          EVIDENCE
        );
  },
};
