/** T-17 跨进程租约竞争夹具：子进程用独立进程/独立 DB 连接尝试 append。 */
import { writeFileSync } from "node:fs";
import { createJsonlSessionStore } from "../jsonl-store.ts";
import { createSqliteSessionStore } from "../sqlite-store.ts";

const [backend, path, resultPath] = process.argv.slice(2);
const create = backend === "jsonl" ? createJsonlSessionStore : createSqliteSessionStore;
const store = create({ path, leaseOwner: "child-process", retryMs: 50 });
let result;
try {
  await store.append({ role: "user", content: "child-process" });
  result = { ok: true };
} catch (error) {
  result = { ok: false, code: error instanceof Error && "code" in error ? String(error.code) : String(error) };
}
writeFileSync(resultPath, JSON.stringify(result));
store.close();
