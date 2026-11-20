#!/usr/bin/env bun
import { main } from "./apps/zeta-cli/src/index";

export { main };

if (import.meta.main) {
  process.exitCode = await main();
}
