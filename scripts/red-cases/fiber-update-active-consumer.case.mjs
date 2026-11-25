import { FiberSystem, key } from "../../packages/components/cordis/src/fiber.ts";
import { green, red } from "./common.mjs";

const EVIDENCE =
  "packages/components/cordis/src/fiber.ts:314-332（update 置 updating=true）、:115-117（updating 时 release 不 notify）、:403-414（unload 无界等待 stillActive）";

export default {
  id: "RED-02-fiber-update-active-consumer",
  title: "provider update() 有 ACTIVE consumer 时必须有界完成",
  expectation: "provider.update() 在 500ms 内 settle（consumer 被 guard 通知撤回或超时记错，不得无限等待）",
  target: "AC-03",
  async probe() {
    const system = new FiberSystem();
    const svc = key("red-update-svc");
    const baseSpec = (uid, extra) => ({ uid, inject: [], provide: [], ...extra });
    const provider = system.create(baseSpec("red-update-provider", { provide: [svc] }));
    const consumer = system.create(baseSpec("red-update-consumer", { inject: [svc] }));
    await provider.refresh();
    await consumer.refresh();

    const before = { provider: provider.state.kind, consumer: consumer.state.kind };
    let settled = false;
    const update = provider.update().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const outcome = await Promise.race([
      update.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("timeout-500ms"), 500)),
    ]);
    const actual = { before, outcome, settled, consumerStateAfter: consumer.state.kind };

    return settled
      ? green(actual, EVIDENCE)
      : red(
          actual,
          "provider.update() 在 ACTIVE consumer 下 500ms 未 settle：release() 因 updating=true 跳过 notify，consumer 仍 committed 到旧 binding，unload() 的 stillActive 轮询无超时上限",
          EVIDENCE
        );
  },
};
