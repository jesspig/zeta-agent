import { homedir } from "node:os";
import { join } from "node:path";

export function resolveDataDir(home: string = homedir(), name = ".zeta-agent"): string {
  return join(home, name);
}
