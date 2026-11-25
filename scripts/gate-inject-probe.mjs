import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "zeta-gate-inject-"));
const file = join(dir, "state.json");
writeFileSync(file, "{}");
rmSync(file);
if (existsSync(file)) throw new Error("INJECT_NOOP");
try {
  readFileSync(file);
  throw new Error("INJECT_NOT_DETECTED");
} catch (error) {
  if (error.message === "INJECT_NOT_DETECTED") throw error;
}
rmSync(dir, { recursive: true, force: true });
console.log("INJECT_OK");
