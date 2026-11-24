import { describe, expect, test } from "bun:test";
import { createStdoutWriter } from "./stdout";

describe("T-21 stdout 专用 writer", () => {
  test("协议输出只走 stdout，diagnostics 只走 stderr", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const writer = createStdoutWriter({
      write: (chunk) => {
        out.push(chunk);
        return true;
      },
      diagnostic: (line) => {
        err.push(line);
      },
    });
    writer.write('{"jsonrpc":"2.0","id":1,"result":{}}');
    writer.diagnostic("zeta: daemon starting");
    await writer.flush();
    expect(out).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
    expect(err).toEqual(["zeta: daemon starting"]);
  });

  test("有界队列触发背压，溢出计入 drop 且不阻塞调用方", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const writer = createStdoutWriter({
      write: (chunk) => {
        out.push(chunk);
        return true;
      },
      diagnostic: (line) => err.push(line),
      queueLimit: 2,
      paused: true,
    });
    expect(writer.write("a")).toBe(true);
    expect(writer.write("b")).toBe(true);
    expect(writer.write("c")).toBe(false);
    expect(writer.dropped).toBe(1);
    expect(err.some((line) => line.includes("STDOUT_BACKPRESSURE"))).toBe(true);
    writer.resume();
    await writer.flush();
    expect(out).toEqual(["a", "b"]);
  });

  test("底层流返回 false 时不丢行，flush 后全部落盘", async () => {
    const out: string[] = [];
    let calls = 0;
    const writer = createStdoutWriter({
      write: (chunk) => {
        calls += 1;
        out.push(chunk);
        return calls === 1 ? false : true;
      },
    });
    writer.write("a");
    writer.write("b");
    await writer.flush();
    expect(out).toEqual(["a", "b"]);
  });

  test("close 先 flush 再失效，后续写入被拒绝并诊断", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const writer = createStdoutWriter({
      write: (chunk) => {
        out.push(chunk);
        return true;
      },
      diagnostic: (line) => err.push(line),
    });
    writer.write("pending");
    await writer.close();
    expect(out).toEqual(["pending"]);
    expect(writer.write("late")).toBe(false);
    expect(err.some((line) => line.includes("STDOUT_CLOSED"))).toBe(true);
  });
});
