import { createTenantGovernance } from "../../packages/agent/src/tenant/governance.ts";
import { green, red } from "./common.mjs";

const EVIDENCE =
  "packages/components/capabilities/src/principal.ts:33-41（缺 spaceId 时回退 default）、packages/agent/src/tenant/governance.ts:134-142（resolve({}) 静默解析默认租户）";

export default {
  id: "RED-07-tenant-origin-missing",
  title: "缺少 origin/spaceId 的租户解析必须拒绝，不能回退默认租户",
  expectation: "governance.resolve({}) 抛出显式的失败关闭错误（如 TENANT_ORIGIN_REQUIRED），不返回默认 scope",
  target: "AC-15",
  async probe() {
    const governance = createTenantGovernance();
    let rejected = false;
    let error = "";
    let principal = null;
    try {
      const scope = governance.resolve({});
      principal = {
        userId: scope.principal.userId,
        spaceId: scope.principal.spaceId,
      };
    } catch (caught) {
      rejected = true;
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      await governance.dispose();
    }
    const actual = { rejected, principal, error };
    return rejected
      ? green(actual, EVIDENCE)
      : red(
          actual,
          `resolve({}) 静默返回默认租户 ${JSON.stringify(principal)}：缺少 origin/spaceId 未失败关闭，违反租户隔离的显式拒绝要求`,
          EVIDENCE
        );
  },
};
