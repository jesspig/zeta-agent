import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResourceRegistry } from "./registry";
import { createTrustGate } from "./trust";

/** CR-23：发现接口不得在授权前泄露项目资源正文。 */
describe("T-22 资源正文信任门", () => {
  let agentRoot: string;
  let projectRoot: string;
  beforeEach(() => {
    agentRoot = mkdtempSync(join(tmpdir(), "zeta-res-agent-"));
    projectRoot = mkdtempSync(join(tmpdir(), "zeta-res-proj-"));
    mkdirSync(join(projectRoot, "prompts"), { recursive: true });
    writeFileSync(join(projectRoot, "prompts", "secret.md"), "PROJECT-SECRET-BODY", "utf8");
  });
  afterEach(() => {
    rmSync(agentRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("discover 不返回项目资源正文", () => {
    const registry = createResourceRegistry({ agentRoot, projectRoot, trust: createTrustGate() });
    const entries = registry.discover().entries.filter((e) => e.scope === "project");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.content === "")).toBe(true);
  });

  test("load 在信任后返回正文", () => {
    const trust = createTrustGate();
    const registry = createResourceRegistry({ agentRoot, projectRoot, trust });
    const entry = registry.discover().entries.find((e) => e.scope === "project")!;
    expect(() => registry.load(entry.id)).toThrow("TRUST_REQUIRED");
    trust.authorize(projectRoot);
    expect(String(registry.load(entry.id).content)).toBe("PROJECT-SECRET-BODY");
  });
});
