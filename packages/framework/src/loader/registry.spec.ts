import { describe, expect, test } from "bun:test";
import { defineComponent } from "../context";
import { createComponentRegistry } from "./registry";

const component = (name: string) =>
  defineComponent({ name, inject: [], provide: [], apply: () => () => {} });

describe("T-05 registry.replace 同身份替换", () => {
  test("保留 uid/parent/config/realm，revision 递增，不是只改 slot", () => {
    const realm = Symbol("registry-realm");
    const registry = createComponentRegistry({ nextUid: (() => { let n = 0; return () => `uid-${++n}`; })() });
    const old = component("old");
    const replacement = component("new");
    const config = { port: 1 };
    const original = registry.register(old, { parent: "root", config, realm });
    const seen: Array<{ id: string; revision: number }> = [];
    registry.watch((node, previous) => {
      seen.push({ id: node.component.name, revision: node.revision });
      expect(previous?.component.name).toBe("old");
    });

    const next = registry.replace(old, replacement);

    expect(next).not.toBe(original);
    expect(next.uid).toBe(original.uid);
    expect(next.parent).toBe("root");
    expect(next.config).toBe(config);
    expect(next.realm).toBe(realm);
    expect(next.component).toBe(replacement);
    expect(next.revision).toBe(1);
    expect(registry.revisionOf(replacement)).toBe(1);
    expect(registry.get(old)).toBeUndefined();
    expect(registry.byUid(original.uid)).toBe(next);
    expect(registry.size).toBe(1);
    expect(seen).toEqual([{ id: "new", revision: 1 }]);
    expect(() => registry.replace(old, component("other"))).toThrow("UNREGISTERED_COMPONENT");
  });

  test("连续替换保留身份并单调递增 revision", () => {
    const registry = createComponentRegistry();
    const a = component("a");
    const b = component("b");
    const c = component("c");
    const first = registry.register(a, { uid: "stable", config: 7 });
    const second = registry.replace(a, b);
    const third = registry.replace(b, c);
    expect([first.uid, second.uid, third.uid]).toEqual(["stable", "stable", "stable"]);
    expect([first.revision, second.revision, third.revision]).toEqual([0, 1, 2]);
    expect(third.config).toBe(7);
  });
});
