import { describe, expect, test } from "bun:test";
import { defineContract, defineFacet, grantFor } from "@zeta-agent/framework";
import { createExperienceStore } from "../research/experience";
import { createTenantGovernance } from "./governance";

const Service = defineContract({
  name: "tenant.service",
  version: "1",
  params: {},
  members: { value: "value" },
});

describe("T-18 租户对象 host 接线", () => {
  test("每租户得到复用自身 context/principal/realm 的独立 host，跨 realm 调用被拒", async () => {
    const governance = createTenantGovernance({ createExperienceStore: () => createExperienceStore() });
    const a = governance.resolve({ spaceId: "space-a", userId: "u-a" });
    const b = governance.resolve({ spaceId: "space-b", userId: "u-b" });

    expect(a.objectHost).not.toBe(b.objectHost);
    expect(a.objectHost.telemetry).not.toBe(b.objectHost.telemetry);

    const facet = defineFacet((host) => {
      host.serve(Service, () => ({ value: "ok" }));
    });
    await a.objectHost.load([{ name: "svc", facet }]);

    const grantA = grantFor(
      { userId: "u-a", spaceId: "space-a", realm: a.realm },
      [Service.name]
    );
    const denied = await b.objectHost.get(Service, undefined, {
      principal: { userId: "u-b", spaceId: "space-b", realm: b.realm },
      grant: grantA,
    });
    expect(denied.state).toBe("denied");

    const allowed = await a.objectHost.get(Service, undefined, {
      principal: { userId: "u-a", spaceId: "space-a", realm: a.realm },
      grant: grantA,
    });
    await allowed.ready;
    expect(allowed.state).toBe("live");

    await governance.dispose();
    expect(allowed.state).toBe("ended");
  });
});
