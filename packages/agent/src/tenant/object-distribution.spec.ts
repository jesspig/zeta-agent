import { describe, expect, test } from "bun:test";
import { createJobRunner, createRollout, openStore, type JobRunner, type RolloutController, type Store } from "@zeta-agent/framework";
import { createExperienceStore } from "../research/experience";
import { createTenantGovernance } from "./governance";

describe("T-19 租户对象数据面接线", () => {
  test("store/jobs/rollout 按 realm 注入且独立，disposeRealm 关闭对应资源", async () => {
    const stores: Record<string, Store> = {};
    const jobs: Record<string, JobRunner> = {};
    const rollouts: Record<string, RolloutController> = {};
    let closedStores = 0;
    let closedJobs = 0;

    const governance = createTenantGovernance({
      createExperienceStore: () => createExperienceStore(),
      createObjectStore: (principal) => {
        const store = openStore();
        stores[principal.spaceId] = store;
        const original = store.close.bind(store);
        store.close = () => {
          closedStores += 1;
          return original();
        };
        return store;
      },
      createObjectJobs: (principal) => {
        const runner = createJobRunner({ handler: () => principal.spaceId, generation: 1 });
        jobs[principal.spaceId] = runner;
        const original = runner.close.bind(runner);
        runner.close = () => {
          closedJobs += 1;
          return original();
        };
        return runner;
      },
      createObjectRollout: (principal) => {
        const rollout = createRollout({ hosts: [principal.spaceId], initialGeneration: 1 });
        rollouts[principal.spaceId] = rollout;
        return rollout;
      },
    });

    const a = governance.resolve({ spaceId: "space-a", userId: "u-a" });
    const b = governance.resolve({ spaceId: "space-b", userId: "u-b" });
    expect(a.objectStore).toBe(stores["space-a"]);
    expect(b.objectStore).toBe(stores["space-b"]);
    expect(a.objectStore).not.toBe(b.objectStore);
    expect(a.objectJobs).toBe(jobs["space-a"]);
    expect(a.objectRollout?.generationFor("space-a")).toBe(1);
    expect(b.objectRollout?.generationFor("space-b")).toBe(1);

    await governance.disposeRealm(a.realm);
    expect(closedStores).toBe(1);
    expect(closedJobs).toBe(1);
    await governance.dispose();
    expect(closedStores).toBe(2);
    expect(closedJobs).toBe(2);
  });
});
