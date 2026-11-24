import { describe, expect, test } from "bun:test";
import {
  acceptVersion,
  adopt,
  applyImmutable,
  assertContract,
  assertFingerprint,
  ContractError,
  defineContract,
  defineDocument,
  hashValue,
  isContract,
  memoryLinkPair,
  openDocument,
  openStore,
  prepare,
  track,
  transactDocuments,
} from "./index";

describe("objects/contract", () => {
  test("fingerprint 规范化哈希、accepts 版本映射、伪造与版本不符被拒（FAILED）", () => {
    const spec = {
      name: "example.greeter",
      version: "2.0",
      params: { language: "zh", level: 1 },
      members: { greet: "method" },
      accepts: { "1.0": "2.0" },
    };
    const contract = defineContract(spec);
    const reordered = defineContract({
      name: spec.name,
      version: spec.version,
      members: spec.members,
      params: { level: 1, language: "zh" },
      accepts: spec.accepts,
    });

    expect(contract.fingerprint).toBe(reordered.fingerprint);
    expect(contract.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }));
    expect(defineContract({ ...spec, params: { language: "en", level: 1 } }).fingerprint).not.toBe(
      contract.fingerprint
    );

    expect(acceptVersion(contract, "2.0")).toBe("2.0");
    expect(acceptVersion(contract, "1.0")).toBe("2.0");
    expect(() => acceptVersion(contract, "3.0")).toThrow(ContractError);
    try {
      acceptVersion(contract, "3.0");
    } catch (error) {
      expect((error as ContractError).kind).toBe("FAILED");
      expect((error as ContractError).reason).toBe("VERSION_MISMATCH");
    }

    const forged = { ...contract };
    expect(isContract(forged)).toBe(false);
    expect(() => assertContract(forged)).toThrow(ContractError);
    expect(() => assertFingerprint(contract, "deadbeef")).toThrow(ContractError);
  });
});

describe("objects/store", () => {
  test("并发按序提交、close 幂等、表版本单调", async () => {
    const store = openStore();
    const table = store.defineTable("counter", 0);
    expect(store.version(table)).toBe(0);

    const versions = await Promise.all([
      store.commit(table, 1),
      store.commit(table, 2),
      store.commit(table, 3),
    ]);
    expect(versions).toEqual([1, 2, 3]);
    expect(store.read(table)).toBe(3);
    expect(store.version(table)).toBe(3);

    const firstClose = store.close();
    expect(store.close()).toBe(firstClose);
    await firstClose;
    expect(store.closed).toBe(true);
    await store.close();
    expect(() => store.commit(table, 4)).toThrow("STORE_CLOSED");
  });
});

describe("objects/document", () => {
  test("事务 draft/put/get/retire、未变 draft 不提交、abort/throw 丢弃、单写者", async () => {
    const store = openStore();
    const definition = defineDocument({ name: "cfg", initial: { a: 1, b: { c: 2 } } });
    const handle = openDocument(store, definition);
    expect(store.version(handle.table)).toBe(0);

    await transactDocuments(store, (tx) => {
      const draft = tx.draft(handle);
      expect(tx.get(handle)).toEqual({ a: 1, b: { c: 2 } });
      expect(tx.draft(handle)).toBe(draft);
      draft.a = 1;
    });
    expect(store.version(handle.table)).toBe(0);

    await transactDocuments(store, (tx) => {
      const draft = tx.draft(handle);
      draft.b.c = 3;
      tx.put(handle, draft);
      expect(tx.get(handle)).toEqual({ a: 1, b: { c: 3 } });
    });
    expect(store.read(handle.table)).toEqual({ a: 1, b: { c: 3 } });
    expect(store.version(handle.table)).toBe(1);

    await transactDocuments(store, (tx) => {
      tx.put(handle, { a: 9, b: { c: 9 } });
      tx.abort();
    });
    expect(store.version(handle.table)).toBe(1);
    expect(store.read(handle.table)).toEqual({ a: 1, b: { c: 3 } });

    await expect(
      transactDocuments(store, (tx) => {
        tx.put(handle, { a: 7, b: { c: 7 } });
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(store.version(handle.table)).toBe(1);

    await transactDocuments(store, (tx) => {
      expect(tx.draft(handle)).toEqual({ a: 1, b: { c: 3 } });
    });

    await transactDocuments(store, (tx) => tx.retire(handle));
    expect(store.read(handle.table)).toBe(null);
    await transactDocuments(store, (tx) => {
      expect(tx.get(handle)).toBe(null);
    });
    await store.close();
  });
});

describe("objects/link", () => {
  test("queueMicrotask 有序、单 listener、onClose 立即回调、关闭后 send no-op", async () => {
    const [a, b] = memoryLinkPair();
    const received: unknown[] = [];
    b.onMessage((message) => received.push(message));
    expect(() => b.onMessage(() => {})).toThrow("SINGLE_LISTENER");

    a.send(1);
    a.send(2);
    a.send(3);
    expect(received).toEqual([]);
    await Promise.resolve();
    expect(received).toEqual([1, 2, 3]);

    let closed = 0;
    a.onClose(() => {
      closed += 1;
    });
    expect(closed).toBe(0);
    a.close();
    expect(closed).toBe(1);
    expect(a.closed).toBe(true);

    a.send(4);
    await Promise.resolve();
    expect(received).toEqual([1, 2, 3]);

    a.onClose(() => {
      closed += 1;
    });
    expect(closed).toBe(2);
  });
});

describe("objects/delta", () => {
  test("精确 op 按序、不可变无可变共享、不安全路径与伪造 delta 被拒", () => {
    const base = { a: 1, b: { c: 2 }, list: [1, 2] };
    const tracker = track(base);
    tracker.set(["a"], 10);
    tracker.set(["b", "c"], 20);
    tracker.set(["list", 0], 9);
    tracker.delete(["b", "missing"]);

    const pending = prepare(tracker);
    expect(pending.ops.map((op) => op[0])).toEqual(["s", "s", "s", "d"]);
    const delta = adopt(pending);
    expect(delta.seq).toBeGreaterThan(0);

    const next = applyImmutable(base, delta);
    expect(next).toEqual({ a: 10, b: { c: 20 }, list: [9, 2] });
    expect(base).toEqual({ a: 1, b: { c: 2 }, list: [1, 2] });
    expect((next as { b: unknown }).b).not.toBe(base.b);

    expect(() => applyImmutable(base, {} as never)).toThrow("INVALID_DELTA");
    expect(() => tracker.set(["__proto__"], {})).toThrow("UNSAFE_PATH");
    expect(() => tracker.set(["constructor"], 1)).toThrow("UNSAFE_PATH");
  });

  test("adopt 一个使其余 pending stale", () => {
    const tracker = track({ x: 1 });
    tracker.set(["x"], 2);
    const first = prepare(tracker);
    const second = prepare(tracker);
    expect(first.stale).toBe(false);
    expect(second.stale).toBe(false);
    adopt(first);
    expect(first.stale).toBe(false);
    expect(second.stale).toBe(true);
  });

  test("Thm80：不同加载顺序按权威序号应用后状态一致", () => {
    const base = { a: 1, b: { c: 2 } };
    const first = track(base);
    first.set(["a"], 5);
    const delta1 = adopt(prepare(first));

    const second = track(applyImmutable(base, delta1));
    second.set(["b", "c"], 7);
    const delta2 = adopt(prepare(second));

    const byOrder = [delta1, delta2].sort((left, right) => left.seq - right.seq);
    const reversed = [delta2, delta1].sort((left, right) => left.seq - right.seq);

    const replicaA = byOrder.reduce((state, delta) => applyImmutable(state, delta), base);
    const replicaB = reversed.reduce((state, delta) => applyImmutable(state, delta), base);

    expect(replicaA).toEqual(replicaB);
    expect(replicaA).toEqual({ a: 5, b: { c: 7 } });
  });
});
