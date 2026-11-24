import { describe, expect, test } from "bun:test";
import {
  BackpressureError,
  createJsonCodec,
  ipcLinkPair,
  memoryLinkPair,
  PeerClosedError,
  wsLinkPair,
  type RichLink,
} from "./index";

async function tick(ms = 10): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("T-19/link: codec、backpressure、receipt、peer close", () => {
  test("JSON codec 编解码帧；伪造/缺字段帧被拒", () => {
    const codec = createJsonCodec();
    const frame = { id: 1, seq: 2, generation: 3, kind: "data" as const, payload: { a: 1 } };
    const raw = codec.encode(frame);
    expect(codec.decode(raw)).toEqual(frame);
    expect(() => codec.decode("not json")).toThrow();
    expect(() => codec.decode(JSON.stringify({ id: 1, seq: 2 }))).toThrow("INVALID_WIRE_FRAME");
  });

  test("receipt 在 peer 收到后兑现；背压暂停时超限抛错，恢复后全部投递并 onDrain", async () => {
    const [a, b] = memoryLinkPair({ maxQueue: 3, generation: 5 });
    const received: unknown[] = [];
    b.onMessage((message) => received.push(message));
    a.pause();
    a.send("m1");
    a.send("m2");
    a.send("m3");
    expect(a.queued).toBe(3);
    expect(() => a.send("m4")).toThrow(BackpressureError);
    let drained = 0;
    a.onDrain(() => {
      drained += 1;
    });
    a.resume();
    await tick();
    expect(received).toEqual(["m1", "m2", "m3"]);
    expect(drained).toBe(1);

    const receipt = await a.sendWithReceipt({ hello: true });
    expect(receipt.ok).toBe(true);
    expect(receipt.generation).toBe(5);
    expect(received[3]).toEqual({ hello: true });
  });

  test("peer close 立即通知并拒绝在途 receipt；关闭后 send no-op", async () => {
    const [a, b] = memoryLinkPair();
    let closes = 0;
    a.onClose(() => {
      closes += 1;
    });
    const pending = a.sendWithReceipt("late");
    b.close();
    await expect(pending).rejects.toThrow(PeerClosedError);
    await tick();
    expect(closes).toBe(1);
    expect(a.closed).toBe(true);
    a.send("ignored");
    await tick();
  });

  test("旧进程迟到消息（旧代次帧）被接收方丢弃", async () => {
    const codec = createJsonCodec();
    const [, fresh] = memoryLinkPair({ generation: 9 });
    const received: unknown[] = [];
    fresh.onMessage((message) => received.push(message));
    const stale = codec.encode({ id: 1, seq: 1, generation: 4, kind: "data", payload: "from-old-process" });
    fresh.ingest(stale);
    await tick();
    expect(received).toEqual([]);
    const current = codec.encode({ id: 2, seq: 2, generation: 9, kind: "data", payload: "ok" });
    fresh.ingest(current);
    await tick();
    expect(received).toEqual(["ok"]);
  });
});

describe("T-19/link: IPC 与 WS 跨边界", () => {
  test("IPC（worker_threads MessageChannel）跨端口带 receipt", async () => {
    const [a, b] = ipcLinkPair({ generation: 2 });
    const received: unknown[] = [];
    b.onMessage((message) => received.push(message));
    const receipt = await a.sendWithReceipt("ipc");
    expect(receipt.ok).toBe(true);
    expect(receipt.generation).toBe(2);
    expect(received).toEqual(["ipc"]);
    a.close();
    b.close();
  });

  test("网络中断后重建 link 可恢复投递（旧 receipt 被拒、新 receipt 兑现）", async () => {
    const [oldA, oldB] = ipcLinkPair();
    oldB.onMessage(() => {});
    const stale = oldA.sendWithReceipt("before-outage", 30);
    oldA.close();
    oldB.close();
    await expect(stale).rejects.toThrow(PeerClosedError);

    const [a, b] = ipcLinkPair({ generation: 2 });
    const received: unknown[] = [];
    b.onMessage((message) => received.push(message));
    const receipt = await a.sendWithReceipt("after-recovery");
    expect(receipt.ok).toBe(true);
    expect(received).toEqual(["after-recovery"]);
    a.close();
    b.close();
  });

  test("WS（真实 loopback）断网时 peer close 可观测", async () => {
    const [serverLink, clientLink]: readonly [RichLink, RichLink] = await wsLinkPair({ generation: 6 });
    const received: unknown[] = [];
    serverLink.onMessage((message) => received.push(message));
    const receipt = await clientLink.sendWithReceipt("ws");
    expect(receipt.ok).toBe(true);
    expect(received).toEqual(["ws"]);
    let closed = 0;
    serverLink.onClose(() => {
      closed += 1;
    });
    clientLink.close();
    await tick(30);
    expect(closed).toBeGreaterThanOrEqual(1);
  });
});
