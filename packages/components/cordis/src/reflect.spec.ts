import { describe, expect, test } from "bun:test";
import type { CoeffectKey } from "@zeta-agent/framework";
import {
  commit,
  createNode,
  createProxy,
  get,
  intercept,
  isolate,
  set,
} from "./reflect";
import { key } from "./fiber";

const svc = key<string>("svc");

describe("coeffect 反射", () => {
  test("未声明访问抛 UNDECLARED_ACCESS", () => {
    const node = createNode("root", null, []);
    expect(() => get(node, svc)).toThrow("UNDECLARED_ACCESS");
  });

  test("声明但未提交抛 INACTIVE_ACCESS", () => {
    const node = createNode("root", null, [svc]);
    expect(() => get(node, svc)).toThrow("INACTIVE_ACCESS");
  });

  test("isolate realm 独立绑定，不串到父链", () => {
    const parent = createNode("parent", null, [svc]);
    commit(parent, svc, "parent");
    const realmB = Symbol("realm-b");
    const derived = isolate(parent, svc, realmB);
    expect(get(parent, svc)).toBe("parent");
    expect(() => get(derived, svc)).toThrow("INACTIVE_ACCESS");
    const dispose = set(derived, svc, "child");
    expect(get(derived, svc)).toBe("child");
    expect(get(parent, svc)).toBe("parent");
    dispose();
    expect(() => get(derived, svc)).toThrow("INACTIVE_ACCESS");
  });

  test("intercept 读时合并元数据且不改变 committed", () => {
    const parent = createNode("parent", null, [svc]);
    commit(parent, svc, "base");
    const sizeBefore = parent.committed.size;
    const derived = intercept(parent, svc, (value) => `${String(value)}:tagged`);
    expect(get(derived, svc)).toBe("base:tagged");
    expect(parent.committed.size).toBe(sizeBefore);
  });

  test("get/set 可经 Proxy 拦截并回到父链解析", () => {
    const parent = createNode("parent", null, [svc]);
    commit(parent, svc, "base");
    const child = createNode("child", parent, [svc]);
    const proxy = createProxy<{ [svc: symbol]: string }>(child);
    expect(proxy[svc.symbol as unknown as keyof typeof proxy]).toBe("base");
    const dispose = set(child, svc, "override");
    expect(get(child, svc)).toBe("override");
    expect(get(parent, svc)).toBe("base");
    dispose();
    expect(get(child, svc)).toBe("base");
  });
});
