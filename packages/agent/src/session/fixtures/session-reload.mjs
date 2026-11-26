/** T-18 跨进程会话恢复夹具：独立进程重新打开 JSONL store 并打印真实 committed 投影。 */
import { createJsonlSessionStore } from "../jsonl-store.ts";

const [path] = process.argv.slice(2);
const store = createJsonlSessionStore({ path, leaseOwner: "t18-reload-reader" });
const projection = store.projection();
process.stdout.write(JSON.stringify({
  sessionId: store.sessionId,
  messages: projection.messages,
  lineageCount: projection.lineage.length,
  uris: projection.lineage.flatMap((lineage) => [...lineage.uris]),
}) + "\n");
store.close();
