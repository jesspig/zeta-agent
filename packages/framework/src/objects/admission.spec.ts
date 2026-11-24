import { describe, expect, test } from "bun:test";
import {
  AdmissionError,
  assertAdmitted,
  classifyObjectError,
  createHost,
  createObjectTelemetry,
  decideAdmission,
  defineContract,
  defineFacet,
  grantFor,
  type AdmissionDecision,
  type ObjectPrincipal,
} from "./index";

function denyReason(decision: AdmissionDecision): string | undefined {
  return decision.kind === "deny" ? decision.reason : undefined;
}

const Dep = defineContract({ name: "example.dep", version: "1", params: {}, members: {} });
const Main = defineContract({ name: "example.main", version: "1", params: {}, members: {} });

function principal(space = "s1"): ObjectPrincipal {
  return { userId: "u", spaceId: space, realm: Symbol(`realm:${space}`) };
}

describe("objects/admission 默认 fail-closed", () => {
  test("缺 principal / 缺 grant / realm 与 principal 不对齐 / 身份不符一律 deny", () => {
    const p = principal();
    expect(denyReason(decideAdmission({}))).toBe("MISSING_PRINCIPAL");
    expect(denyReason(decideAdmission({ principal: p }))).toBe("MISSING_GRANT");
    expect(denyReason(decideAdmission({ principal: p, grant: { ...grantFor(p, ["*"]), realm: Symbol("x") } }))).toBe("REALM_MISMATCH");
    expect(
      denyReason(decideAdmission({
        principal: p,
        grant: { ...grantFor(p, ["*"]), principal: { ...p, userId: "attacker" } },
      }))
    ).toBe("PRINCIPAL_MISMATCH");
  });

  test("资源/动作/来源未授权与撤销 grant 被拒；custom policy 只能收紧", () => {
    const p = principal();
    const grant = grantFor(p, ["allowed"], {
      id: "g1",
      actions: ["get"],
      origins: [{ kind: "facet", host: "trusted" }],
    });
    expect(denyReason(decideAdmission({ principal: p, grant, resource: "forbidden" }))).toBe("RESOURCE_FORBIDDEN");
    expect(denyReason(decideAdmission({ principal: p, grant, resource: "allowed", action: "write" }))).toBe("ACTION_FORBIDDEN");
    expect(denyReason(decideAdmission({ principal: p, grant, resource: "allowed", origin: { kind: "facet", host: "evil" } }))).toBe("ORIGIN_FORBIDDEN");
    expect(denyReason(decideAdmission({ principal: p, grant, revokedGrants: new Set(["g1"]) }))).toBe("GRANT_REVOKED");
    expect(decideAdmission({ principal: p, grant, resource: "allowed" }).kind).toBe("allow");

    const tightened = decideAdmission(
      { principal: p, grant, resource: "allowed" },
      () => ({ kind: "deny", reason: "ORIGIN_FORBIDDEN" })
    );
    expect(tightened.kind).toBe("deny");
    expect(() => assertAdmitted(tightened)).toThrow(AdmissionError);
    expect(classifyObjectError(new AdmissionError("GRANT_REVOKED"))).toBe("ADMISSION");
  });

  test("grant 不声称资源时默认拒绝（拒绝不保留值）", async () => {
    const host = createHost();
    const facet = defineFacet((h) => {
      h.serve(Main, () => ({ ok: true }));
    });
    await host.load([{ name: "m", facet }]);
    const p = principal();
    const ref = await host.get(Main, undefined, { principal: p, grant: grantFor(p, []) });
    expect(ref.state).toBe("denied");
    expect(ref.value).toBeUndefined();
    await host.close();
  });
});

describe("objects/park 依赖未就绪", () => {
  test("requires 未就绪时 loading+parking，依赖转 live 后自动重试并进入 live", async () => {
    const host = createHost();
    const mainFacet = defineFacet((h) => {
      h.serve(Main, () => ({ ok: true }), { requires: [Dep], digest: "m1" });
    });
    await host.load([{ name: "m", facet: mainFacet }]);
    const p = principal();
    const grant = grantFor(p, [Dep.name, Main.name]);

    const parked = await host.get(Main, undefined, { principal: p, grant });
    expect(parked.state).toBe("loading");
    expect(parked.reason).toBe(`PARKED:${Dep.name}`);

    const depFacet = defineFacet((h) => {
      h.serve(Dep, () => ({ ok: true }));
    });
    await host.load([{ name: "d", facet: depFacet }]);
    const dep = await host.get(Dep, undefined, { principal: p, grant });
    await dep.ready;
    expect(dep.state).toBe("live");

    await parked.ready;
    expect(parked.state).toBe("live");
    expect(parked.value).toEqual({ ok: true });
    parked.release();
    dep.release();
    await host.close();
  });
});

describe("objects/telemetry 与诊断", () => {
  test("事件流记录 serve/get/admission/restart，错误分类覆盖 contract/factory/timeout", async () => {
    const telemetry = createObjectTelemetry();
    const host = createHost({ telemetry });
    let digest = "v1";
    const facet = () =>
      defineFacet((h) => {
        h.serve(Main, () => ({ ok: true }), { digest });
      });
    await host.load([{ name: "m", facet: facet() }]);
    const p = principal();
    const grant = grantFor(p, [Main.name]);

    const ok = await host.get(Main, undefined, { principal: p, grant });
    await ok.ready;
    await host.get(Main, undefined, { principal: p }); // denied → admission 事件

    digest = "v2";
    await host.reload([{ name: "m", facet: facet() }]);

    const kinds = telemetry.events.map((event) => event.kind);
    expect(kinds).toContain("serve");
    expect(kinds).toContain("get");
    expect(kinds).toContain("admission");
    expect(kinds).toContain("restart");
    expect(telemetry.events.some((event) => event.errorClass === "ADMISSION")).toBe(true);
    await host.close();
  });
});
