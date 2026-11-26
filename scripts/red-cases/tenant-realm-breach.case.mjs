import { quotaKey } from "../../packages/components/capabilities/src/quota.ts";
import { createExperienceStore } from "../../packages/agent/src/research/experience.ts";
import { createTenantGovernance } from "../../packages/agent/src/tenant/governance.ts";
import { green, red } from "./common.mjs";

const EVIDENCE =
  "packages/agent/src/tenant/governance.ts:build/resolve（共享回退与缺 origin 静默默认）、packages/agent/src/tenant/dual-tenant.spec.ts（双租户渗透）";

export default {
  id: "RED-11-tenant-realm-breach",
  title: "双租户 realm 渗透：工厂/origin/research/quota/coeffect 不得串扰或静默回退",
  expectation:
    "缺工厂与缺 origin 显式拒绝；research/quota 按 realm 独立；quota 以 coeffect key 按 realm provide",
  target: "AC-15",
  async probe() {
    const governance = createTenantGovernance({
      tokensPerTenant: 2,
      createExperienceStore: () => createExperienceStore(),
    });
    let factoryRejected = false;
    let originError = "";
    try {
      createTenantGovernance().resolve({ spaceId: "no-factory" });
    } catch {
      factoryRejected = true;
    }
    try {
      createTenantGovernance().resolve({});
    } catch (caught) {
      originError = caught instanceof Error ? caught.message : String(caught);
    }

    let researchIsolated = false;
    let quotaIsolated = false;
    let coeffectIsolated = false;
    try {
      const a = governance.resolve({ spaceId: "breach-a" });
      const b = governance.resolve({ spaceId: "breach-b" });
      researchIsolated = a.research !== b.research;
      a.quota.reserve(2);
      quotaIsolated = a.quota.remaining() === 0 && b.quota.remaining() === 2;
      coeffectIsolated = a.get(quotaKey) === a.quota && b.get(quotaKey) === b.quota;
    } finally {
      await governance.dispose();
    }

    const actual = { factoryRejected, originError, researchIsolated, quotaIsolated, coeffectIsolated };
    const ok =
      factoryRejected &&
      originError.includes("TENANT_ORIGIN_REQUIRED") &&
      researchIsolated &&
      quotaIsolated &&
      coeffectIsolated;
    return ok
      ? green(actual, EVIDENCE)
      : red(actual, "双租户边界未闭合：存在共享回退、静默默认或未按 realm 提供 coeffect", EVIDENCE);
  },
};
