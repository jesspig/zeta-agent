# @zeta-agent/testing

框架汇合性、可逆性与 guard 断言工具底座，对应 IF-21 与 A3/A4/A5。

## 工具

- `assertQuiescent(ctx, timeoutMs)`：轮询所有 fiber 直到进入 settled 状态（PENDING/ACTIVE/FAILED/DISPOSED）；超时失败信息含未静止 fiber 的 uid 与 kind。
- `assertNoResidue(ctx, baseline)`：断言每个 effect 的逆恰好调用一次，观察状态回到基线；失败信息含 uid 与键名。
- `replayConfig(orders, run)`：用多种加载顺序重放，断言最终观察状态一致（Thm 80 汇合性）。
- `observeDispose(effects, disposeAll)`：记录逆调用序列并验证 LIFO 顺序。

## 观察状态

`observeState(value)` 产生与键顺序无关的稳定快照，`sameObservation(left, right)` 基于该快照比较。
断言失败信息统一包含 fiber uid 与键名，便于定位汇合或残留问题。

## 用法

```ts
import { assertQuiescent, assertNoResidue, observeState } from "@zeta-agent/testing";
```
