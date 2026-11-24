import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPackageGraph,
  detectPackageCycles,
  findCoreTypeDeclarations,
  findCrossPackageRelativeImports,
  inventoryRootContextReads,
  validateSharedPeerIdentity,
} from "./guard-architecture.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "zeta-architecture-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function manifest(name, dependencies = {}, peerDependencies = {}) {
  return JSON.stringify({ name, private: true, dependencies, peerDependencies }, null, 2);
}

describe("package graph guard", () => {
  test("collects workspace edges and rejects cycles", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/a/package.json": manifest("@zeta-agent/a", { "@zeta-agent/b": "workspace:*" }),
      "packages/b/package.json": manifest("@zeta-agent/b", { "@zeta-agent/a": "workspace:*" }),
    });
    try {
      const graph = collectPackageGraph(root);
      expect(graph.get("@zeta-agent/a")).toEqual(["@zeta-agent/b"]);
      expect(detectPackageCycles(graph)).toEqual([["@zeta-agent/a", "@zeta-agent/b", "@zeta-agent/a"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects relative imports crossing package roots through the TypeScript AST", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/a/package.json": manifest("@zeta-agent/a"),
      "packages/b/package.json": manifest("@zeta-agent/b"),
      "packages/a/src/index.ts": `import type { Value } from "../../b/src/value";\nexport { Value } from "../../b/src/value";\nvoid import("../../b/src/value");`,
      "packages/b/src/value.ts": "export type Value = string;",
    });
    try {
      const violations = findCrossPackageRelativeImports(root);
      expect(violations).toHaveLength(3);
      expect(violations.every((item) => item.includes("@zeta-agent/a") && item.includes("@zeta-agent/b"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows relative imports within one package", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/a/package.json": manifest("@zeta-agent/a"),
      "packages/a/src/index.ts": `import { value } from "./value";\nexport { value } from "./nested/value";`,
      "packages/a/src/value.ts": "export const value = 1;",
      "packages/a/src/nested/value.ts": "export const value = 2;",
    });
    try {
      expect(findCrossPackageRelativeImports(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects conflicting shared peer identities", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/shared/package.json": manifest("@zeta-agent/shared"),
      "packages/a/package.json": manifest("@zeta-agent/a", {}, { "@zeta-agent/shared": "workspace:*" }),
      "packages/b/package.json": manifest("@zeta-agent/b", {}, { "@zeta-agent/shared": "^1.0.0" }),
    });
    try {
      expect(validateSharedPeerIdentity(root)).toEqual([
        expect.stringContaining("@zeta-agent/shared"),
        expect.stringContaining("workspace:*"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects duplicate core type declarations outside cordis", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/framework/package.json": manifest("@zeta-agent/framework"),
      "packages/framework/src/types.ts": "export interface CoeffectKey<T> { readonly symbol: symbol }",
      "packages/framework/src/types.spec.ts": "export interface Impl {}",
    });
    try {
      expect(findCoreTypeDeclarations(root)).toEqual([
        { name: "CoeffectKey", file: "packages/framework/src/types.ts", line: 1 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inventories root context reads without scanning tests", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/framework/package.json": manifest("@zeta/framework"),
      "packages/framework/src/context.ts": "export const read = (ctx: { get(key: symbol): unknown }) => ctx.get(Symbol('key'));",
      "packages/framework/src/context.spec.ts": "ctx.get(Symbol('test'));",
    });
    try {
      const reads = inventoryRootContextReads(root);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatch(/packages\/framework\/src\/context\.ts:1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
