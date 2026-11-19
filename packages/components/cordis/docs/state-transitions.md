# Fiber 六态转移表

对应 `core-semantics.md` §7.1 状态图；实现见 `src/fiber.ts`。

| 当前态 | 事件/条件 | 下一态 | 说明 |
| --- | --- | --- | --- |
| — | O-Insert | PENDING | 初始态 |
| PENDING | target ≠ null（L-Begin） | LOADING | 依赖齐备开始加载 |
| LOADING | L-Iter / L-Finish | LOADING | 迭代继续 |
| LOADING | 最后一步完成 | ACTIVE | 提交 committed view |
| LOADING / ACTIVE | target 改变（L-Divert） | UNLOADING | 先停止提供 |
| LOADING | 迭代抛错（raise） | FAILED | 跑完已累积逆，不自动重试 |
| UNLOADING | guard 满足且逆完成（L-Unload） | PENDING | 卸载完成回 PENDING，非 DISPOSED |
| PENDING | O-Remove（空表且无子） | DISPOSED | 独立终态 |
| 任意态 | O-Retire | 自环 | target 置 null 后链入 unload |

## guard 语义

provider 进入 UNLOADING 后，先等待其 `dependents` 中仍非 PENDING/DISPOSED/FAILED 的消费者去活，再执行逆并回 PENDING。`update()` 是 FAILED 的唯一显式恢复入口；`refresh()` 对 FAILED 为 no-op。
