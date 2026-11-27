import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTelemetrySpool, telemetrySpoolLockPort } from "./spool";

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

describe("FileTelemetrySpool", () => {
  test("Windows 同一文件的大小写别名共享锁端口", () => {
    if (process.platform !== "win32") return;
    expect(telemetrySpoolLockPort("C:\\Foo\\telemetry.jsonl")).toBe(
      telemetrySpoolLockPort("c:\\foo\\telemetry.jsonl"),
    );
  });

  test("JSONL append/ack 可跨实例恢复，compact 仅原子保留未 ack 记录", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-telemetry-spool-"));
    const path = join(root, "telemetry.jsonl");
    const spool = createFileTelemetrySpool<{ message: string }>({ path });
    try {
      const first = await spool.enqueue({ message: "acked" });
      const second = await spool.enqueue({ message: "pending" });
      await spool.ack(first.id);
      expect(await spool.load()).toEqual([second]);
      await spool.compact();
      const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toEqual([{ type: "enqueue", id: second.id, value: { message: "pending" } }]);
      expect(readdirSync(root)).toEqual(["telemetry.jsonl"]);
      await spool.close();

      const restarted = createFileTelemetrySpool<{ message: string }>({ path });
      try {
        expect(await restarted.load()).toEqual([second]);
      } finally {
        await restarted.close();
      }
    } finally {
      await spool.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("未 ack 记录在重启后原样重放，允许至少一次重复投递", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-telemetry-spool-replay-"));
    const path = join(root, "telemetry.jsonl");
    const beforeCrash = createFileTelemetrySpool<string>({ path });
    try {
      const entry = await beforeCrash.enqueue("event");
      const firstDelivery = await beforeCrash.load();
      await beforeCrash.close();
      const afterCrash = createFileTelemetrySpool<string>({ path });
      try {
        const secondDelivery = await afterCrash.load();
        expect(firstDelivery).toEqual([entry]);
        expect(secondDelivery).toEqual(firstDelivery);
      } finally {
        await afterCrash.close();
      }
    } finally {
      await beforeCrash.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("双实例互斥，close 释放 OS 端口锁", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-telemetry-spool-lock-"));
    const path = join(root, "telemetry.jsonl");
    const first = createFileTelemetrySpool<number>({ path });
    const second = createFileTelemetrySpool<number>({ path, lockTimeoutMs: 30, lockRetryMs: 5 });
    try {
      await first.enqueue(1);
      await expect(second.enqueue(2)).rejects.toThrow("TELEMETRY_SPOOL_LOCK_TIMEOUT");
      await first.close();
      const entry = await second.enqueue(2);
      const loaded = await second.load();
      expect(loaded.map((item) => item.value)).toEqual([1, 2]);
      expect(loaded).toContainEqual(entry);
    } finally {
      await Promise.all([first.close(), second.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("固定高端口被外部占用时等待到 timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-telemetry-spool-port-"));
    const path = join(root, "telemetry.jsonl");
    const port = telemetrySpoolLockPort(path);
    const server = createServer((socket) => socket.destroy());
    const spool = createFileTelemetrySpool<string>({ path, lockTimeoutMs: 30, lockRetryMs: 5 });
    try {
      await listen(server, port);
      await expect(spool.enqueue("blocked")).rejects.toThrow("TELEMETRY_SPOOL_LOCK_TIMEOUT");
      await closeServer(server);
      const entry = await spool.enqueue("after-release");
      expect(await spool.load()).toEqual([entry]);
    } finally {
      if (server.listening) await closeServer(server);
      await spool.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("末尾无换行的残缺 JSON 尾被截断，有效记录保留且可继续 append", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-telemetry-spool-torn-tail-"));
    const path = join(root, "telemetry.jsonl");
    const spool = createFileTelemetrySpool<string>({ path });
    try {
      const valid = await spool.enqueue("valid");
      appendFileSync(path, '{"type":"enqueue","id":"torn"', "utf8");
      expect(await spool.load()).toEqual([valid]);
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ type: "enqueue", ...valid }) + "\n");
      const next = await spool.enqueue("next");
      expect(await spool.load()).toEqual([valid, next]);
    } finally {
      await spool.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("损坏 JSONL 行显式失败，不静默丢弃遥测", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-telemetry-spool-corrupt-"));
    const path = join(root, "telemetry.jsonl");
    const spool = createFileTelemetrySpool<string>({ path });
    try {
      await spool.enqueue("valid");
      appendFileSync(path, "{truncated\n", "utf8");
      await expect(spool.load()).rejects.toThrow("TELEMETRY_SPOOL_CORRUPT_LINE: 2");
    } finally {
      await spool.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
