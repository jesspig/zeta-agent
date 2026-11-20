# 递归自演化 Harness：DREAM-RSI 与 Harness² 调研

> 文档编号：研究篇 S17/S18　|　主题：递归自我改进的两个 Google Research 项目，及其对"万物皆插件"框架自演化设计的补强
> 一手来源：
> - S17 [google-research/dream-rsi](https://github.com/google-research/dream-rsi)（DREAM-RSI: Recursive Self-Improvement Through Evolving Worlds，Apache-2.0）
> - S18 [google-research/harness2](https://github.com/google-research/harness2)（Harness²: Recursive Agent Harnessing for an Open World，[arXiv:2610.14224](https://arxiv.org/abs/2610.14224)，Apache-2.0）
> 检索截止：2026-11-19。**定位**：这是研究轨参考，第一版极简 harness 不实现递归自演化；但框架必须预留原语。
> 所属索引：[research/README.md](./README.md)　|　落地：[agent/plugin-system.md §8](../agent/plugin-system.md#8-自演化与安全管理)　|　事实登记：[architecture/fact-registry.md](../architecture/fact-registry.md)

## 目录

- [1 为什么这两个项目重要](#1-为什么这两个项目重要)
- [2 DREAM-RSI：约束可变面的自演化](#2-dream-rsi约束可变面的自演化)
- [3 Harness²：harness 作为可编辑配方](#3-harness²harness-作为可编辑配方)
- [4 两者的共性与关键差异](#4-两者的共性与关键差异)
- [5 对现有设计的优化建议](#5-对现有设计的优化建议)
- [6 落地批次](#6-落地批次)
- [7 交叉引用与验证](#7-交叉引用与验证)

---

## 1 为什么这两个项目重要

论文 [arXiv:2608.25512v1](https://arxiv.org/abs/2608.25512v1) 的结论把 **self-evolving agent harness** 列为首要未来验证方向（[cordis-paper-system §14](./cordis-paper-system.md#14-与本项目目标的关系)）：agent 持续生成并替换自身 harness 组件。我们的 `plugin-system.md §8` 目前只回答了"受控热替换是否安全"，**没有回答"如何生成、评估、晋升并递归地改进 harness 自身"**——这两个项目正好补这个缺口。

**核心洞察**：
- DREAM-RSI 的安全性来自**约束可变面**（只改一个决策文件，其余全冻结），而不是靠运行时回滚；
- Harness² 把 harness 当成**可编辑配方树**，用 Propose–Probe–Compose + 无 ground truth 的行为对比来改进；
- 两者都证明：**递归自演化的关键不是"能不能替换组件"（我们的 fiber 已解决），而是"改什么 / 如何评估 / 如何晋升 / 如何防止退化"**。

## 2 DREAM-RSI：约束可变面的自演化

### 2.1 递归循环（explore → learning → promote）

权威：[`dream_rsi/orchestrate.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/orchestrate.py)。三阶段 `Stage = Literal["explore","learning","promote"]`，docstring 明确 "no sim2real porting stage — online and offline run the same `policy.solve(env)`"。

| 阶段 | 函数 | 动作 |
| --- | --- | --- |
| explore | `_run_explore_stage` | `load_agent` → `default_policy_source` → `run_live` → 写 manifest |
| learning | `_run_learning_stage` | 同步 trace pool → 可选方向摘要 → `run_discover_sync` |
| promote | `_run_promote_stage` | `promote_method_to_workspace` |
| 循环 | `run_cycle` / `run_pipeline` | 每轮 `_archive_and_reset_workspace`（归档 = 冻结 replay world） |

**单调改进判定** `_discover_ok`：只有 `best_round.method_src` 与 `method_file` 字节相等且 `eval_returncode==0` 才算成功；若 incumbent 胜出则不复制（"current policy stays in force"）。这是干净的**不退化保证**。

### 2.2 统一决策面 SearchEnv（online/replay 对偶）

权威：[`dream_rsi/env/types.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/env/types.py)（`SearchEnv` Protocol）与 [`trace_env.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/env/trace_env.py)。

- `ExperimentMode = Literal["replay","live"]`，两个工厂 `TraceEnv.replay(...)` / `TraceEnv.live(...)`；
- **唯一分叉点在 `step`/`probe`**：live 真跑 agent + evaluator，replay 校验 `is_evaluated` 后直接揭示冻结分数；之后完全共用 `_reveal`（`budget_spent += 1`、按父分数算 delta）；
- 决策接口对称性：`LLMDesignedMethod.solve(question: SearchEnv, budget) -> SimResult`；
- `CellMeta` 只含揭示前可见的结构信息（无结果泄漏），`Observation` 含 score/valid/fail_class/budget_spent 等。

**关键启示**：同一 `policy.solve(surface)` 接 live adapter（真跑工具）与 replay adapter（读冻结快照），消除 sim2real 移植——这正是自演化策略可比较的前提。

### 2.3 冻结 trace 与适应度（Eq.1）

权威：[`trace_pool.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/learning/trace_pool.py)、[`eval.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/learning/heuristic_search/eval.py)。

- **failed attempts 记 0**（[`raw.py::_attempted_zero_cell`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/env/trace/raw.py)）：若记成未评估，replay 会当脚手架跳过而虚假节省预算——这是"奖励黑客"的真实防线；
- **防泄漏**：按 `iterNNN` 顺序重放，已完成轮的 manifest 累积为 `planning_history` 传给后续，重放看到与当时 online 相同的前缀；
- **Eq.1**：`reward = mean_auc − λ · mean_penalty`，其中 `penalty = effective_sequential_rounds / total_budget`（serial≈1，满并行≈1/W），`λ=0.05`；`trace_auc` 是 attainment(best/runBest) 对 nEvaluated 的非支配超体积积分；
- "是否达标"单独报告，不并入预算轴；replay 不变量 `budget===len(order)`、无重复、每步 isLegal、`best<=runBest`。

### 2.4 可编辑面最小化与晋升

权威：[`discovered_sandbox.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/learning/heuristic_search/discovered_sandbox.py)（`EDITABLE_FILES = ("method.py",)`）、[`workflow.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/learning/heuristic_search/workflow.py)。

- 只有 `method.py` 可编辑；框架模块（api/grid_planning/observation_signal/baseline）**只读**；
- 每轮从模板重置，仅首个 proposal 可继承 incumbent；
- 版本 ID `r0000_<ts>_<uid>` 全量归档 + `best_round.json` + sha256 校验晋升；
- 资格校验 `_qualification_reason`：eval rc=0、无失败 trace、有限 reward、有 execution episodes——**"资格"不等于"评估成功"**；
- 有界重试（`initial_rounds + retry_rounds * max_retry_batches`）；
- resume：workspace 不覆盖，`RESUME=1` 从归档目录推断 `startCycle`，manifest 存在则跳过已完成 explore。

### 2.5 局限（必须标注，不能照搬）

- **只适用可重放的决策问题**：frozen trace 依赖"环境状态可由历史分数表重建"。harness 组件（工具/权限/session/TUI/provider）变更会改变环境本身，同一 trace 无法再评分，必须重新 rollout（项目自己也未做论文 §4.4 的 harness optimization 实验）；
- **无运行时热替换**：策略是下一轮才生效的"冷切换"，不经过 fiber mount/unmount，无法验证 `ctx.effect` 逆、依赖重激活、LIFO guard；
- 生成物是单一 Python 文件字符串，无 inject 声明/accepts 版本/capability 清单，不能直接复用我们的信任体系。

## 3 Harness²：harness 作为可编辑配方

### 3.1 四个易被论文叙事误导的事实

权威：[`harness2/core/prompts.py`](https://github.com/google-research/harness2/blob/main/harness2/core/prompts.py)、[`proposer.py`](https://github.com/google-research/harness2/blob/main/harness2/core/proposer.py)、[`library.py`](https://github.com/google-research/harness2/blob/main/harness2/core/library.py)。

1. **没有 HarnessEditor/HarnessComposer/ExperienceReflector 类**——四个角色全是 prompt 文本 + 同一个 `Proposer.call()` 原语，靠 mission 字符串和 label（`inv1`/`dom1`/`agg1`/`c1`/`experience.agg1`）区分。**角色是 seam，不是类**。
2. **"improvement harness"无独立类型**——载体是 `Library`（经验库 R）+ `_distil` 产出的 lesson。
3. **8 组件不是 8 个插件**——它们是 `Tree = dict[str,str]`（rel path → content）里的文件路径族；只有 c8（plugin/hook）在 tool loop 内生效。
4. **无 ground truth 是代码强制的**——`ANSWER_FREE`、`assert_no_grader_verdicts` tripwire、`RunView` "Never carries a score"，评分只在 selection committed 后由 judge 调用。

### 3.2 两层递归

- **task-level（Propose–Probe–Compose）**：[`recursion.py`](https://github.com/google-research/harness2/blob/main/harness2/core/recursion.py) `run_mode` 的 on-disk token 只有 `agg`（parallel）/`seq`（sequential）。预算恒等式 `expected_rollouts(k)=4k`、`expected_sessions(k)=3k`（[`ledger.py`](https://github.com/google-research/harness2/blob/main/harness2/core/ledger.py)）。
- **harnessing-level（跨任务）**：[`selection.py`](https://github.com/google-research/harness2/blob/main/harness2/core/selection.py) `reflect_adoption` → `_distil` → `Library.add`；每个任务只读更早任务（`retain(task_ids[:i-1])`），多模式各持一个 Library（"shared mutable library would leak one mode into another"）。

### 3.3 8 个可编辑组件（分三类，不是 8 个 fiber 插件）

| 分组 | 组件 | 运行时角色 | 我们的对应 |
| --- | --- | --- | --- |
| 构造 context | system prompt, guardrails, memory, skills | always-on 文本 + 按需加载 | **keyed coeffect section + order**（非 fiber） |
| 定义 tool interface | tool guidance, scripts | 散文 + 确定性 helper | section / `ctx.use` job fiber |
| 编排 delegation | subagents | 独立 context 返回文本 | 子 agent 节点协议 |
| 控制 middleware | plugins | **唯一在 tool loop 内生效** | `beforeToolCall` + `ctx.intercept` 策略插件 |

> c2 context policy 在 Harness² 自己都标 `NOT injectable`（框架拥有）——对应我们的 L1 required root，保持不可替换。

**编辑契约**：`Tree = Readonly<Record<RelativePath,string>>`，"edits on disk ARE the proposal" + omitted-is-inherited + delete-to-remove；整棵验证失败即丢弃（重试 1 次）。[SurfaceSpec](https://github.com/google-research/harness2/blob/main/harness2/core/tree.py) 统一驱动可编辑路径白名单/always-on 预算/自动触发/校验/stub。

### 3.4 Propose–Probe–Compose 细节

- **INV vs DOM 双角色**：INV（how the agent WORKS：工具/脚本/子代理/短规则）vs DOM（what a practitioner knows：事实/skill/触发行）；判定句"换个主题/换个行业还成立吗"防互相污染；
- **大证据写文件、prompt 只给指针**（[`context.py`](https://github.com/google-research/harness2/blob/main/harness2/core/context.py)）：全量轨迹/交付物/harness/library 落 `context/`，mission 只说"从磁盘读，别从消息里答"——"nothing is truncated to fit a prompt"；
- **composer 输入三件套**：`harness.diff` + `rollout.md` + `produced.md`（代码差异与行为差异并置）；notes 格式 `kept|revised|dropped -> edit -> evidence`（无证据的决策不可审计）；
- **KEEP_BASE 是合法输出**：无证据支持的适配是回归。

### 3.5 经验沉淀

[`prompts.experience`](https://github.com/google-research/harness2/blob/main/harness2/core/prompts.py) 产出 `edit rows`（component/candidates/change/observed/verdict，verdict 含 `confounded`）与 `lesson`（cue/lesson/evidence/confidence）。纪律：**采纳 ≠ 某个编辑起作用**（selection 对输出盲选）；优先 `confounded` 避免伪因果污染经验库；无可迁移对比则写 `NO_ENTRY`。[Library](https://github.com/google-research/harness2/blob/main/harness2/core/library.py) 按 benchmark/k/substrate/mode/domain 隔离，`has_experience` 要求 cue/lesson/evidence 三者齐全。

### 3.6 三轴分离

[`spec.py`](https://github.com/google-research/harness2/blob/main/harness2/core/spec.py) 明确 **method / substrate / benchmark 三轴分离**；[`substrate/base.py`](https://github.com/google-research/harness2/blob/main/harness2/substrate/base.py) 的 `Substrate` 只持有宿主注入的 `launcher`（"宿主拥有 runner 选择/env/read-back"），未注入则明确抛错——与"显式优于隐式、依赖通过参数传入"一致。

## 4 两者的共性与关键差异

| 维度 | DREAM-RSI | Harness² | 对我们的意义 |
| --- | --- | --- | --- |
| 演化对象 | 单一决策文件 `method.py` | 8 组件配方树 | 两种可变面策略都需预留 |
| 评估 | 冻结 trace + Eq.1 适应度（有分数） | 同任务行为对比 + 盲选（无 ground truth） | fitness 与 judge 都要做成 seam |
| 改进方式 | 离线程序合成 + 重放回归 | Propose–Probe–Compose | 提案/评估/晋升三阶段通用 |
| 切换 | 冷切换（下一轮生效） | 冷切换（下一任务采纳） | **都不做运行时热替换**——我们的 fiber 热替换是差异化能力 |
| 防退化 | incumbent 参赛 + 严格更优才晋升 | KEEP_BASE + confounded 优先 | 单调改进是共同纪律 |
| 恢复 | workspace 不覆盖 + RESUME | fingerprint + runmark + identity check | digest/版本谱系通用 |

**关键结论**：两个项目都刻意避开运行时热替换（因为研究焦点是"改得对不对"而非"切得安不安全"）。**我们既有 fiber 热替换（切得安全），又需补上这两个项目的"改得对不对"机制**——两者结合才是完整的自演化设计。

## 5 对现有设计的优化建议

> 层：L1=通用框架 `@zeta-agent/framework`；L2=Agent 框架 `@zeta-agent/agent-framework`；L3=agent。SE-D/SE-H 系列清单见本文 §5；Meta-Harness 的 SE-M 系列见 [harness-optimization-papers.md §4](./harness-optimization-papers.md#4-建议汇总se-m-ct-)；AS/CR/LG 系列见 [capability-reservation.md §5](./capability-reservation.md#5-优化建议总表)。

### 来自 DREAM-RSI（SE-D 系列）

| ID | 层 | 目标文档节 | 建议 | 来源 |
| --- | --- | --- | --- | --- |
| SE-D1 | L2 | `plugin-system §8` | **策略插件白名单沙箱**：`defineStrategyPlugin({editable:["decision.ts"], frozenExports:[...]})`，每轮从模板重置 | [`discovered_sandbox.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/learning/heuristic_search/discovered_sandbox.py) |
| SE-D2 | L1 | `framework/components §8` | **冻结 trace / frozen coeffect**：`ctx.freeze(key,snapshot)` + `FrozenStore`（immutable + manifest） | [`trace_pool.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/learning/trace_pool.py) |
| SE-D3 | L2 | `agent-framework/runtime` | **统一决策面 DecisionSurface**（live/replay 对偶），消除 sim2real 移植 | [`env/types.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/env/types.py) |
| SE-D4 | L2 | `state-and-events §10` | **决策剧情事件流**：`{before,batch,parallelism,outcomes,after}` + `replayEpisode(events)` | [`trace_env.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/env/trace_env.py) |
| SE-D5 | L2 | `tools-and-policies §7` | **fitness 插件槽**：`reward=mean_auc−λ·mean_penalty`，达标单独报告 | [`eval.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/learning/heuristic_search/eval.py) |
| SE-D6 | L2 | `plugin-system §8` | **资格门禁 + incumbent 参赛 + 严格更优才晋升**（sha256 + 版本谱系） | [`workflow.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/learning/heuristic_search/workflow.py) |
| SE-D7 | L1 | `framework/components §8` | **晋升原子替换 + digest 校验**：copy → sha256 比对 → 失败保留旧 entry | [`workflow.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/learning/heuristic_search/workflow.py) |
| SE-D8 | L3 | `delivery/roadmap` | **workspace 不覆盖 + RESUME 状态机** | [`run_dream_rsi.sh`](https://github.com/google-research/dream-rsi/blob/main/scripts/run_dream_rsi.sh) |
| SE-D9 | L2 | `state-and-events §11` | **历史种子与剪枝**（copy/symlink + 按历史最佳过滤） | [`history_seed.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/exploration/history_seed.py) |
| SE-D10 | L1 | `api-and-testing` | **重放不变量测试**：budget===order.length、无重复、isLegal、best≤runBest | [`pipeline.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/learning/pipeline.py) |
| SE-D11 | L2 | `plugin-system §7` | **stage-scoped 工具权限**：explore→files only、learning→files+shell（引擎级 policy 兜底） | [`gemini.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/agents/gemini.py) |
| SE-D12 | L2 | `plugin-system §9` | **多 agent 后端统一工厂 + 优雅关闭**（进程组 SIGKILL 防孤儿烧 quota） | [`agents/base.py`](https://github.com/google-research/dream-rsi/blob/main/dream_rsi/agents/base.py) |

### 来自 Harness²（SE-H 系列）

| ID | 层 | 目标文档节 | 建议 | 来源 |
| --- | --- | --- | --- | --- |
| SE-H1 | L2 | `capability-reservation §3.3` | **`EditableSurface` 元契约**（alwaysOn/cap/dirs/validators）作为 AgentPlugin contribution，默认 noop | [`tree.py`](https://github.com/google-research/harness2/blob/main/harness2/core/tree.py) |
| SE-H2 | L2 | `plugin-system §8` | **整棵 rel→content 树编辑 + omitted-is-inherited**（非 patch DSL） | [`prompts.py`](https://github.com/google-research/harness2/blob/main/harness2/core/prompts.py) |
| SE-H3 | L1+L2 | `plugin-system §8` 护栏 | **harnessFingerprint + 精确逆 + resume 复核** | [`runmark.py`](https://github.com/google-research/harness2/blob/main/harness2/core/runmark.py) |
| SE-H4 | L2 | `capability-reservation §5` | **INV/DOM 两个 EditorRole seam** | [`prompts.py`](https://github.com/google-research/harness2/blob/main/harness2/core/prompts.py) |
| SE-H5 | L2 | `state-and-events §11` | **无分数 ProbeView**（`ok`/`delivered` 分离，score 走独立 judge seam） | [`spec.py`](https://github.com/google-research/harness2/blob/main/harness2/core/spec.py) |
| SE-H6 | L2 | `plugin-system §8` | **compose 输入三件套**（diff+rollout+produced）+ 可审计 notes | [`context.py`](https://github.com/google-research/harness2/blob/main/harness2/core/context.py) |
| SE-H7 | L1+L2 | `framework/components §store` | **Evidence-as-files**：大证据落文件，prompt 只给指针 | [`context.py`](https://github.com/google-research/harness2/blob/main/harness2/core/context.py) |
| SE-H8 | L1+L2 | `plugin-system §7/§8` | **grader-verdict tripwire**（三个边界强制断言，命中即抛错） | [`context.py`](https://github.com/google-research/harness2/blob/main/harness2/core/context.py) |
| SE-H9 | L2 | `plugin-system §8` | **ExperienceReflector seam**（cue/lesson/evidence/confidence + confounded） | [`selection.py`](https://github.com/google-research/harness2/blob/main/harness2/core/selection.py) |
| SE-H10 | L2 | `capability-reservation §3.3` | **per-domain ExperienceLibrary coeffect + 流序契约** | [`library.py`](https://github.com/google-research/harness2/blob/main/harness2/core/library.py) |
| SE-H11 | L1 | `api-and-testing` | **预算恒等式 + 单次重试 + 全程 fallback** 验收不变量 | [`ledger.py`](https://github.com/google-research/harness2/blob/main/harness2/core/ledger.py) |
| SE-H12 | L1 | `framework/components §8` | **content-addressed 缓存**（resolved path 进 key，保证独立抽样） | [`proposer.py`](https://github.com/google-research/harness2/blob/main/harness2/core/proposer.py) |
| SE-H13 | L1+L2 | `framework-model §4` | **三轴协议分离 method / substrate / benchmark** | [`spec.py`](https://github.com/google-research/harness2/blob/main/harness2/core/spec.py) |
| SE-H14 | L2 | `plugin-system §9` | **launcher 由宿主注入，substrate 只持有它** | [`substrate/base.py`](https://github.com/google-research/harness2/blob/main/harness2/substrate/base.py) |
| SE-H15 | L2 | `plugin-system §12.3` | **4 类 always-on 走 keyed section**（非 fiber），预留 section key | [`tree.py`](https://github.com/google-research/harness2/blob/main/harness2/core/tree.py) |
| SE-H16 | L2 | `plugin-system §7` | **tool-loop middleware 是唯一强制执行层**（"Prose can be stopped reading; a hook cannot"） | [`prompts.py`](https://github.com/google-research/harness2/blob/main/harness2/core/prompts.py) |

## 6 落地批次

| 批次 | 内容 | 与极简 harness 的关系 |
| --- | --- | --- |
| 预留（现在做） | SE-H1/H13/H14/H15、SE-D2/D3 的**接口定义** | 只加 seam 契约与 no-op 默认实现，不增加运行时复杂度 |
| 研究轨（阶段 6，可选） | SE-D1/D4/D5/D6/D10、SE-H2/H4/H6/H9/H10 | 需要一个可重放的任务+评估器才能验证，不在第一版产品范围 |
| 护栏强化（阶段 5） | SE-D7/D8/D11、SE-H3/H8/H11/H12、SE-H16 | 即便不做完整自演化，这些护栏也强化受控热替换的安全性 |

**定位裁决点**：`framework-model §1.2` 写"第一版不实现自动代码生成与部署"。建议保持产品轨不变，但把本文作为**研究轨的预留契约清单**——框架预留 seam，未来可插拔地装入递归自演化实现，无需改框架。

## 7 交叉引用与验证

| 本文结论 | 上游来源 | 下游验证 |
| --- | --- | --- |
| 约束可变面是第一道护栏 | S17 `discovered_sandbox.py` | [plugin-system §8](../agent/plugin-system.md#8-自演化与安全管理) 的可演化面清单 |
| 冻结 trace + 适应度 | S17 `trace_pool.py`/`eval.py` | 新增验收 A16-A20 |
| 8 组件分三类预留 | S18 `tree.py`/`prompts.py` | [capability-reservation §3.3](./capability-reservation.md#3-现有扩展点盘点) |
| 角色是 seam 不是类 | S18 `prompts.py`/`proposer.py` | AgentPlugin 管线设计 |
| 三轴分离 | S18 `spec.py`/`substrate/base.py` | [framework-model §4](../architecture/framework-model.md#4-两个框架与应用形态组件拼装模型) |
| 无 ground truth 强制 | S18 `ANSWER_FREE`/tripwire | 安全验收判据 |

**总索引**：[README.md](../README.md)　|　**事实登记**：[fact-registry.md](../architecture/fact-registry.md)
