/** 崩溃注入子进程：每次写 journal 时在 temp-writing 阶段发信号，等待父进程真实 kill。 */
import { atomicWriteFileSync } from "@zeta-agent/security";

const file = process.argv[2];
if (typeof file !== "string" || file.length === 0) throw new Error("MISSING_JOURNAL_PATH");

const pad = "x".repeat(512 * 1024);
function snapshot(revision) {
  return {
    schemaVersion: 1,
    seq: revision,
    pending: [
      {
        kind: "message",
        key: `pending-${revision}`,
        seq: revision,
        payload: pad,
        idempotencyKey: `message\u0000pending-${revision}`,
        state: "queued",
        generation: 0,
        attempts: 0,
      },
    ],
    receipts: [{ kind: "message", key: "settled", ok: true, value: "done", idempotencyKey: "message\u0000settled", generation: 1 }],
    seen: ["message\u0000settled", `message\u0000pending-${revision}`],
    revision,
    consecutiveFailures: 0,
  };
}

atomicWriteFileSync(file, JSON.stringify(snapshot(0)));
process.stdout.write("READY\n");
for (let revision = 1; ; revision += 1) {
  atomicWriteFileSync(file, JSON.stringify(snapshot(revision)), {
    maxWriteChunk: 4096,
    hook: (current) => {
      process.stdout.write(`STAGE:${current}\n`);
    },
  });
  process.stdout.write(`WROTE:${revision}\n`);
}
