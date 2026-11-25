import { FiberSystem, key } from "../../packages/components/cordis/src/fiber.ts";
import { green, red } from "./common.mjs";

const EVIDENCE =
  "packages/components/cordis/src/fiber.ts:304-306（target 非空变化时 state=LOADING 且 dispose=NOOP，旧 dispose 被丢弃）；fixture 用 FiberSystem.claim/release/notify 模拟无空窗的 provider 原子替换";

export default {
  id: "RED-03-fiber-target-change-disposer",
  title: "非空 target 变化必须先执行旧 disposer",
  expectation: "provider 从 v1 原子替换为 v2（target 非空 → 非空）后，consumer 的旧 apply disposer 至少执行一次",
  target: "AC-03",
  async probe() {
    const system = new FiberSystem();
    const svc = key("red-target-change-svc");
    let oldDisposerCalls = 0;

    const provider = system.create({
      uid: "red-target-provider",
      inject: [],
      provide: [],
      autoProvide: false,
    });
    const bindingV1 = system.claim(svc, system.defaultRealm, "v1", provider);
    const consumer = system.create({
      uid: "red-target-consumer",
      inject: [svc],
      provide: [],
      apply: () => () => {
        oldDisposerCalls += 1;
      },
    });
    await provider.refresh();
    await consumer.refresh();
    const before = oldDisposerCalls;

    // 无空窗替换：抑制 release 的 notify，让 claim 成为唯一的 target 变更通知。
    // 这样 consumer 看到的是 v1 → v2 的非空 target 变化，而不是 v1 → null → v2。
    provider.updating = true;
    system.release(bindingV1);
    system.claim(svc, system.defaultRealm, "v2", provider);
    provider.updating = false;
    await system.drain(1000);

    const actual = { before, after: oldDisposerCalls, consumerState: consumer.state.kind };
    return oldDisposerCalls > before
      ? green(actual, EVIDENCE)
      : red(
          actual,
          "非空 target 从 v1 直接变到 v2 后旧 disposer 调用次数仍为 0：refresh() 把旧 state 的 dispose 替换成 NOOP 后直接 reload，只有经过 null 空窗才会触发旧逆",
          EVIDENCE
        );
  },
};
