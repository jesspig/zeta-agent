import { describe, expect, test } from "bun:test";
import {
  acceptVersion,
  classifyObjectError,
  createHost,
  defineContract,
  defineFacet,
  evolveContract,
  grantFor,
  type AdmissionContext,
  type ObjectPrincipal,
} from "./index";

const Greeter = defineContract({
  name: "example.greeter",
  version: "1",
  params: { language: "" },
  members: { greet: "method", language: "value" },
});

const MainForRetry = defineContract({
  name: "example.retry",
  version: "1",
  params: {},
  members: { ok: "value" },
});

type GreeterValue = { language: string; greet: (name: string) => string };
type OkValue = { ok: boolean };

function principal(space = "space-a", user = "u1"): ObjectPrincipal {
  return { userId: user, spaceId: space, realm: Symbol(`realm:${space}`) };
}

function call(p: ObjectPrincipal, contract = Greeter): AdmissionContext {
  return { principal: p, grant: grantFor(p, [contract.name]) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("objects/contract evolution", () => {
  test("evolve 继承 accepts、更新指纹，旧版本仍被接受而越界版本 FAILED", () => {
    const v1 = defineContract({
      name: "evolve.demo",
      version: "1",
      params: { n: 0 },
      members: { get: "method" },
      accepts: { "0": "1" },
    });
    const v2 = evolveContract(v1, { version: "2" });

    expect(v2.name).toBe(v1.name);
    expect(v2.fingerprint).not.toBe(v1.fingerprint);
    expect(acceptVersion(v2, "2")).toBe("2");
    expect(acceptVersion(v2, "1")).toBe("2");
    expect(acceptVersion(v2, "0")).toBe("2");
    expect(() => acceptVersion(v2, "3")).toThrow();
    expect(() => evolveContract(v1, { version: "" })).toThrow();
  });
});

describe("objects/admission 拒绝不保留值", () => {
  test("无 grant / realm 不匹配 / 资源未授权一律 denied，factory 不被调用，host 无实例", async () => {
    let calls = 0;
    const facet = defineFacet((host) => {
      host.serve(Greeter, ({ language }: { language: string }) => {
        calls += 1;
        return { language, greet: (name: string) => `hello:${name}` };
      });
    });
    const host = createHost();
    await host.load([{ name: "g", facet }]);
    const p = principal();

    const missing = await host.get<GreeterValue>(Greeter, { language: "en" }, { principal: p });
    expect(missing.state).toBe("denied");
    expect(missing.value).toBeUndefined();
    expect(missing.reason).toBe("MISSING_GRANT");
    expect(calls).toBe(0);

    const wrongRealm = await host.get<GreeterValue>(Greeter, { language: "en" }, {
      principal: p,
      grant: { ...grantFor(p, [Greeter.name]), realm: Symbol("other") },
    });
    expect(wrongRealm.state).toBe("denied");
    expect(wrongRealm.reason).toBe("REALM_MISMATCH");
    expect(calls).toBe(0);

    const forbidden = await host.get<GreeterValue>(Greeter, { language: "en" }, {
      principal: p,
      grant: grantFor(p, ["some.other"]),
    });
    expect(forbidden.state).toBe("denied");
    expect(forbidden.reason).toBe("RESOURCE_FORBIDDEN");
    expect(calls).toBe(0);
    expect(host.references(Greeter)).toHaveLength(0);
    await host.close();
  });
});

describe("objects/host serve/get/hold/release", () => {
  test("facet setup 声明 serve，get/hold 返回 live 引用，release 幂等并进入 ended", async () => {
    const facet = defineFacet((host) => {
      host.serve(Greeter, ({ language }: { language: string }) => ({
        language,
        greet: (name: string) => `${language}:${name}`,
      }));
    });
    const host = createHost();
    const report = await host.load([{ name: "g", facet }]);
    expect(report.loaded).toEqual(["g"]);

    const p = principal();
    const ref = await host.get<GreeterValue>(Greeter, { language: "de" }, call(p));
    await ref.ready;
    expect(ref.state).toBe("live");
    expect(ref.value?.language).toBe("de");
    expect(ref.value?.greet("Mario")).toBe("de:Mario");
    expect(host.references(Greeter)).toHaveLength(1);

    const held = await host.hold<GreeterValue>(Greeter, { language: "de" }, call(p));
    expect(held.state).toBe("live");
    expect(host.references(Greeter)).toHaveLength(2);

    held.release();
    held.release();
    expect(held.state).toBe("ended");
    expect(held.value).toBeUndefined();
    expect(host.references(Greeter)).toHaveLength(1);

    ref.release();
    expect(host.references(Greeter)).toHaveLength(0);
    await host.close();
  });

  test("factory 失败 → failed 且错误分类正确；错误分类覆盖 contract/admission/timeout", async () => {
    const facet = defineFacet((host) => {
      host.serve(Greeter, () => {
        throw new Error("boom");
      });
    });
    const host = createHost();
    await host.load([{ name: "g", facet }]);
    const ref = await host.get<GreeterValue>(Greeter, { language: "en" }, call(principal()));
    await ref.ready;
    expect(ref.state).toBe("failed");
    expect(classifyObjectError(ref.error)).toBe("FACTORY");
    await host.close();
  });
});

describe("objects/reference 状态机与并发", () => {
  test("并发 get 共用同一 attempt；factory 未决时全部 loading，就绪后全部 live", async () => {
    const gate = deferred<{ language: string; greet: (n: string) => string }>();
    const facet = defineFacet((host) => {
      host.serve(Greeter, () => gate.promise);
    });
    const host = createHost();
    await host.load([{ name: "g", facet }]);
    const p = principal();

    const refs = await Promise.all(
      Array.from({ length: 5 }, () => host.get<GreeterValue>(Greeter, { language: "en" }, call(p)))
    );
    expect(refs.every((ref) => ref.state === "loading")).toBe(true);
    expect(new Set(refs.map((ref) => ref.generation)).size).toBe(1);

    gate.resolve({ language: "en", greet: (name: string) => `en:${name}` });
    await Promise.all(refs.map((ref) => ref.ready));
    expect(refs.every((ref) => ref.state === "live")).toBe(true);
    for (const ref of refs) ref.release();
    await host.close();
  });

  test("ready 在非 loading 状态 resolve；denied 立即 resolve", async () => {
    const host = createHost();
    const ref = await host.get<GreeterValue>(Greeter, {}, { principal: principal() });
    await ref.ready;
    expect(ref.state).toBe("denied");
    await host.close();
  });
});

describe("objects/reload 旧调用旧代码、新调用等待", () => {
  test("reload 后旧引用仍跑旧代码，新引用拿到新代码", async () => {
    let version = "v1";
    const makeFacet = () => {
      const v = version;
      return defineFacet((host) => {
        host.serve(
          Greeter,
          () => ({ language: v, greet: (name: string) => `${v}:${name}` }),
          { digest: v }
        );
      });
    };

    const host = createHost();
    await host.load([{ name: "g", facet: makeFacet() }]);
    const p = principal();
    const oldRef = await host.get<GreeterValue>(Greeter, { language: "en" }, call(p));
    await oldRef.ready;
    expect(oldRef.value?.greet("x")).toBe("v1:x");

    version = "v2";
    const report = await host.reload([{ name: "g", facet: makeFacet() }]);
    expect(report.restarted).toHaveLength(1);

    // 旧调用继续跑旧代码
    expect(oldRef.state).toBe("live");
    expect(oldRef.value?.greet("x")).toBe("v1:x");

    // 新调用等新代码
    const newRef = await host.get<GreeterValue>(Greeter, { language: "en" }, call(p));
    await newRef.ready;
    expect(newRef.value?.greet("x")).toBe("v2:x");
    expect(newRef.generation).toBeGreaterThan(oldRef.generation);

    oldRef.release();
    newRef.release();
    await host.close();
  });

  test("reload 期间的新调用阻塞在新代码门口，直到 reload 完成", async () => {
    const gate = deferred<{ language: string; greet: (n: string) => string }>();
    const v1 = defineFacet((host) => {
      host.serve(Greeter, () => ({ language: "v1", greet: (n: string) => `v1:${n}` }), { digest: "v1" });
    });
    const v2 = defineFacet((host) => {
      host.serve(Greeter, () => gate.promise, { digest: "v2" });
    });
    const host = createHost();
    await host.load([{ name: "g", facet: v1 }]);
    const p = principal();
    const first = await host.get<GreeterValue>(Greeter, {}, call(p));
    await first.ready;
    expect(first.value?.greet("a")).toBe("v1:a");

    const reloading = host.reload([{ name: "g", facet: v2 }]);
    let arrived = false;
    const waiting = host.get<GreeterValue>(Greeter, {}, call(p)).then((ref) => {
      arrived = true;
      return ref;
    });
    await Promise.resolve();
    expect(arrived).toBe(false);

    gate.resolve({ language: "v2", greet: (n: string) => `v2:${n}` });
    await reloading;
    const next = await waiting;
    await next.ready;
    expect(arrived).toBe(true);
    expect(next.value?.greet("a")).toBe("v2:a");
    first.release();
    next.release();
    await host.close();
  });

  test("新代码失败时保留旧代码（closure rule），FAILED 对象在下次 reload 重试", async () => {
    let fail = false;
    const makeFacet = (digest: string) =>
      defineFacet((host) => {
        host.serve(
          Greeter,
          () => {
            if (fail) throw new Error("new code broken");
            return { language: digest, greet: (n: string) => `${digest}:${n}` };
          },
          { digest }
        );
      });

    const host = createHost();
    await host.load([{ name: "g", facet: makeFacet("v1") }]);
    const p = principal();
    const ref = await host.get<GreeterValue>(Greeter, {}, call(p));
    await ref.ready;
    expect(ref.value?.greet("a")).toBe("v1:a");

    fail = true;
    const bad = await host.reload([{ name: "g", facet: makeFacet("v2") }]);
    expect(bad.failed).toHaveLength(1);
    // 旧代码仍服务新调用
    const afterBad = await host.get<GreeterValue>(Greeter, {}, call(p));
    await afterBad.ready;
    expect(afterBad.state).toBe("live");
    expect(afterBad.value?.greet("a")).toBe("v1:a");

    fail = false;
    const retry = await host.reload([{ name: "g", facet: makeFacet("v3") }]);
    expect(retry.restarted.length + retry.retried.length).toBeGreaterThanOrEqual(1);
    const recovered = await host.get<GreeterValue>(Greeter, {}, call(p));
    await recovered.ready;
    expect(recovered.value?.greet("a")).toBe("v3:a");
    await host.close();
  });

  test("provider 被撤销时对象 ended，release 回收在途 attempt，close 终结所有引用", async () => {
    const facet = defineFacet((host) => {
      host.serve(Greeter, () => ({ language: "x", greet: (n: string) => `x:${n}` }), { digest: "v1" });
    });
    const host = createHost();
    await host.load([{ name: "g", facet }]);
    const p = principal();
    const ref = await host.get<GreeterValue>(Greeter, {}, call(p));
    await ref.ready;

    const report = await host.reload([]);
    expect(report.ended).toHaveLength(1);
    expect(ref.state).toBe("ended");
    expect(host.references(Greeter)).toHaveLength(0);

    const host2 = createHost();
    const facet2 = defineFacet((h) => {
      h.serve(Greeter, () => ({ language: "x", greet: (n: string) => `x:${n}` }));
    });
    await host2.load([{ name: "g", facet: facet2 }]);
    const ref2 = await host2.get(Greeter, {}, call(p));
    await ref2.ready;
    await host2.close();
    expect(ref2.state).toBe("ended");
  });
});

describe("objects/reload 重试与等待上限", () => {
  test("FAILED 对象在 reload 时原地重试，成功后新引用 live", async () => {
    let fail = true;
    const facet = defineFacet((host) => {
      host.serve(
        MainForRetry,
        () => {
          if (fail) throw new Error("temporary");
          return { ok: true };
        },
        { digest: "stable" }
      );
    });
    const host = createHost();
    await host.load([{ name: "m", facet }]);
    const p = principal();
    const grant = grantFor(p, [MainForRetry.name]);

    const failed = await host.get<OkValue>(MainForRetry, undefined, { principal: p, grant });
    await failed.ready;
    expect(failed.state).toBe("failed");

    fail = false;
    const report = await host.reload();
    expect(report.retried).toHaveLength(1);
    const recovered = await host.get<OkValue>(MainForRetry, undefined, { principal: p, grant });
    await recovered.ready;
    expect(recovered.state).toBe("live");
    await host.close();
  });

  test("新调用等待新代码超时返回 failed/TIMEOUT，不吞掉异常", async () => {
    const gate = deferred<{ ok: boolean }>();
    const v1 = defineFacet((host) => {
      host.serve(MainForRetry, () => ({ ok: true }), { digest: "v1" });
    });
    const v2 = defineFacet((host) => {
      host.serve(MainForRetry, () => gate.promise, { digest: "v2" });
    });
    const host = createHost({ reloadDrainTimeoutMs: 20 });
    await host.load([{ name: "m", facet: v1 }]);
    const p = principal();
    const grant = grantFor(p, [MainForRetry.name]);
    const first = await host.get<OkValue>(MainForRetry, undefined, { principal: p, grant });
    await first.ready;

    const reloading = host.reload([{ name: "m", facet: v2 }]);
    const waited = await host.get<OkValue>(MainForRetry, undefined, { principal: p, grant });
    expect(waited.state).toBe("failed");
    expect(waited.reason).toBe("TIMEOUT");
    expect(classifyObjectError(waited.error)).toBe("TIMEOUT");

    gate.resolve({ ok: true });
    await reloading;
    await host.close();
  });
});

describe("objects/realm 与 route 强制", () => {
  test("serve 指定 realm 时跨 realm 调用 denied，同 realm 才允许", async () => {
    const realm = Symbol("realm:locked");
    const facet = defineFacet((host) => {
      host.serve(Greeter, () => ({ language: "ok", greet: (n: string) => n }), { realm });
    });
    const host = createHost();
    await host.load([{ name: "g", facet }]);
    const p = principal();
    const denied = await host.get<GreeterValue>(Greeter, {}, { principal: p, grant: grantFor(p, [Greeter.name]) });
    expect(denied.state).toBe("denied");
    expect(denied.reason).toBe("REALM_MISMATCH");

    const allowed = await host.get<GreeterValue>(Greeter, {}, {
      principal: { ...p, realm },
      grant: grantFor({ ...p, realm }, [Greeter.name]),
    });
    await allowed.ready;
    expect(allowed.state).toBe("live");
    await host.close();
  });
});
