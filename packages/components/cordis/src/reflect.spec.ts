import { describe, expect, test } from "bun:test";
import type { CoeffectKey, Impl } from "./types";
import {
  CAPABILITY_EXPIRED,
  INACTIVE_ACCESS,
  UNDECLARED_ACCESS,
  bindRealm,
  bindResolver,
  commit,
  createNode,
  createProxy,
  get,
  getCommitted,
  intercept,
  isolate,
  metadataOf,
  keyRealm,
  set,
} from "./reflect";
import { FiberSystem, key } from "./fiber";

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

  test("G02 commit 注入 check 后 get 抛 CAPABILITY_EXPIRED", () => {
    const node = createNode("root", null, [svc]);
    let valid = true;
    commit(node, svc, "secret", Symbol("default"), () => valid);
    expect(get(node, svc)).toBe("secret");
    valid = false;
    expect(() => get(node, svc)).toThrow(CAPABILITY_EXPIRED);
  });

  test("G03 commit 的 Impl.dependents 可由调用方共享登记", () => {
    const node = createNode("root", null, [svc]);
    const dependents = new Set<string>();
    commit(node, svc, "v", Symbol("default"), undefined, dependents);
    dependents.add("consumer-1");
    expect(node.committed.get(svc)?.dependents.has("consumer-1")).toBe(true);
  });

  test("G04 Proxy 对未声明 symbol 访问抛 UNDECLARED_ACCESS", () => {
    const node = createNode("root", null, [svc]);
    commit(node, svc, "v");
    const proxy = createProxy<{ [k: symbol]: unknown }>(node);
    expect(proxy[svc.symbol]).toBe("v");
    expect(() => proxy[Symbol("undeclared")]).toThrow(UNDECLARED_ACCESS);
  });

  test("T-04 非严格 get 查询不抛错，严格访问保持显式拒绝", () => {
    const undeclared = createNode("root", null, []);
    expect(get(undeclared, svc, false)).toBeUndefined();

    const declared = createNode("declared", null, [svc]);
    expect(get(declared, svc, false)).toBeUndefined();

    commit(declared, svc, "secret", Symbol("default"), () => false);
    expect(get(declared, svc, false)).toBeUndefined();
    expect(() => get(declared, svc)).toThrow(CAPABILITY_EXPIRED);
  });

  test("T-04 Proxy 门禁只按 committed view 解析，裸 store 不可见", () => {
    const node = createNode("root", null, [svc]);
    const proxy = createProxy<{ [k: symbol]: unknown }>(node);
    const restore = set(node, svc, "raw-store");
    expect(get(node, svc)).toBe("raw-store");
    expect(() => getCommitted(node, svc)).toThrow(INACTIVE_ACCESS);
    expect(() => proxy[svc.symbol]).toThrow(INACTIVE_ACCESS);
    restore();

    commit(node, svc, "committed");
    expect(getCommitted(node, svc)).toBe("committed");
    expect(proxy[svc.symbol]).toBe("committed");
  });

  test("T-04 isolate per-key realm：派生键隔离，其他键仍解析父 realm", async () => {
    const other = key<string>("other");
    const parent = createNode("parent", null, [svc, other]);
    const rootRealm = Symbol("root-realm");
    const childRealm = Symbol("child-realm");
    bindRealm(parent, rootRealm);
    const system = new FiberSystem();
    bindResolver(parent, (candidate, realm) => system.committedFor(candidate, realm));
    const provider = system.create({
      uid: "root-provider",
      inject: [],
      provide: [svc, other],
      realm: rootRealm,
      values: new Map<symbol, unknown>([
        [svc.symbol, "root-svc"],
        [other.symbol, "root-other"],
      ]),
    });
    await provider.refresh();

    const derived = isolate(parent, svc, childRealm);
    expect(keyRealm(derived, svc)).toBe(childRealm);
    expect(keyRealm(derived, other)).toBe(rootRealm);
    expect(() => get(derived, svc)).toThrow(INACTIVE_ACCESS);
    expect(get(derived, other)).toBe("root-other");
  });

  test("T-04 Impl generation 可观察，对象 metadata 参与 provider consult", () => {
    const node = createNode("root", null, [svc]);
    let allowed = true;
    let consulted: unknown;
    const impl: Impl = {
      uid: "provider",
      value: "service",
      dependents: new Set<string>(),
      isolate: Symbol("realm"),
      generation: 7,
      consult: (metadata) => {
        consulted = metadata;
        return allowed;
      },
    };
    node.committed.set(svc, impl);
    expect(impl.generation).toBe(7);
    expect(get(node, svc)).toBe("service");
    expect(consulted).toBeUndefined();

    const scoped = intercept(node, svc, { allow: true });
    expect(metadataOf(scoped, svc)).toEqual({ allow: true });
    expect(get(scoped, svc)).toBe("service");
    expect(consulted).toEqual({ allow: true });

    allowed = false;
    expect(() => get(scoped, svc)).toThrow(CAPABILITY_EXPIRED);

    // 函数 metadata 保持 transform 兼容，不走 consult。
    const transformed = intercept(node, svc, (value) => `${String(value)}!`);
    expect(metadataOf(transformed, svc)).toBeUndefined();
    expect(get(transformed, svc)).toBe("service!");
  });
});
