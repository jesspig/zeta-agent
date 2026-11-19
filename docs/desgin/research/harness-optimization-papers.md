# Harness 优化与短上下文：两篇新论文调研

> 文档编号：研究篇 S23/S24　|　主题：两篇论文对自演化研究轨与性能/会话设计的补强
> 一手来源：
> - S23 [arXiv:2603.28052](https://arxiv.org/abs/2603.28052) *Meta-Harness: End-to-End Optimization of Model Harnesses*（Yoonho Lee et al., 2026-03）
> - S24 [arXiv:2611.05306](https://arxiv.org/abs/2611.05306) *You don't need long context*（Peter Belcak et al., 2026-11）
> 所属索引：[research/README.md](./README.md)　|　关联：[recursive-self-evolution.md](./recursive-self-evolution.md)、[framework/observability.md](../framework/observability.md)、[architecture/engineering.md §9.2](../architecture/engineering.md)

## 目录

- [1 两篇论文各自的价值](#1-两篇论文各自的价值)
- [2 Meta-Harness：完整证据与非马尔可夫检索](#2-meta-harness完整证据与非马尔可夫检索)
- [3 You don't need long context：压缩与 SSSM](#3-you-dont-need-long-context压缩与-sssm)
- [4 建议汇总（SE-M / CT-*）](#4-建议汇总se-m--ct-)
- [5 诚实的边界](#5-诚实的边界)
- [6 交叉引用与验证](#6-交叉引用与验证)

---

## 1 两篇论文各自的价值

| 论文 | 核心命题 | 补我们什么 |
| --- | --- | --- |
| **Meta-Harness** | 用 coding agent 作为 proposer，把**所有历史候选的源码+分数+完整执行轨迹**落到一个文件系统，通过 grep/cat 非马尔可夫检索；Table 3 实证"摘要有害、原始轨迹是关键" | 自演化研究轨的**experience store 缺口**（我们已有落盘原语，但缺"任意历史候选的检索 seam"）+ 可观测性的"完整落盘"纪律 |
| **You don't need long context** | 后期 token 成本最高 7x（货币/吞吐换算，延迟约 2x）；频繁压缩几乎不损精度；提出 SSSM（语义状态空间模型）——每上下文只做一个动作、维护可解释自然语言状态 | 性能预算（双阈值 + peak 指标 + 成本 metric）、会话压缩的 typed recap schema、选择性读取工具 |

## 2 Meta-Harness：完整证据与非马尔可夫检索

### 2.1 Outer-loop（§3 / Algorithm 1）

- proposer（Claude Code + Opus-4.6）访问一个**持续增长的 filesystem 𝒟**；每个被评估的 harness 贡献一个目录，含 **source code / scores / execution traces**（prompts、tool calls、model outputs、state updates）；
- 𝒟 通常远大于 proposer 上下文窗口，故用 `grep`/`cat` 查询而非一次性塞进 prompt；
- **无 parent-selection rule、无 scaffold、无持久 memory**——检查任意先验 harness 与 trace；
- 典型运行约 20 轮 × 60 harness；final test-set 只在 **Pareto frontier** 上评一次；proposer 全程不见 test 结果。

### 2.2 "不过度压缩反馈"的硬证据

| 档位 | Scores | Code | Summary | Traces | 中位精度 | 最佳 | >zero-shot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Scores Only | ✓ | ✓ | × | × | 34.6 | 41.3 | 26 |
| Scores + Summary | ✓ | ✓ | ✓ | × | 34.9 | **38.7**（反而更低） | 23 |
| **完整（含 traces）** | ✓ | ✓ | – | ✓ | **50.0** | **56.7** | **39** |

论文结论：*"Access to raw execution traces is the key ingredient… summaries do not recover the missing signal, and may even hurt by compressing away diagnostically useful details."* Table 1：Meta-Harness 单次评估 **10.0 MTok/iter**，比既有文本优化器（0.002–0.026）高**三个数量级**。

### 2.3 实证数字（准确含义）

- **7.7 points**：Table 2，GPT-OSS-120B，test-set 48.6 vs ACE 40.9（另对 MCE +8.6）；
- **4× fewer tokens**：11.4K tokens vs ACE 50.8K（对 MCE 仅 2.5×）。注意 Table 9 的 45.5 是**千字符**、Table 2 的 11.4 是**千 token**，不可混用；
- **+4.7 points**：Table 6，数学检索跨 5 个评估模型（其中 4 个完全未见），38.8 vs no-retriever 34.1；
- **82 files/iter**（§1/Table 8）：TerminalBench-2 proposer 每轮读文件数，41% source / 40% traces / 6% score-summary / 13% other——**非马尔可夫**的铁证。

### 2.4 与我们的差异

| 维度 | Meta-Harness | 我们（含已吸收的 harness²/DREAM-RSI） |
| --- | --- | --- |
| 评分 | 真实 task reward + Pareto | 有分数 fitness（SE-D5）+ 无分数盲选（SE-H5）两个 seam 都保留 |
| 检索 | 任意历史、非马尔可夫 | ❌ **缺此 seam**（本次新增 SE-M3） |
| 可变面 | 单文件 Python 100–1000 行 | 插件束 + 配置 + section 顺序 + entry（多文件，SE-M4） |
| 评估 | 外置独立服务 `Evaluate(H,M,𝒳)` | 已有 fitness seam + live/replay 对偶（SE-D3/M10） |

## 3 You don't need long context：压缩与 SSSM

### 3.1 后期 token 成本（图 1/图 4，Appendix B 公式 1）

- 256K vs 16K 下，生成每 token 成本：GLM **3.6×**、Kimi **5.6×**、Qwen **7×**（货币/吞吐换算，H100 $3.85/GPU-hour，2026-09）；**延迟侧本地测量约 2×**（图 2，DGX Spark）；
- Appendix B 用保守均值 r=0.20 给出线性插值成本模型——**估算模型，非实测账单**。

### 3.2 频繁压缩几乎不损精度（§3）

- 6 个长程 benchmark；阈值如 48K/36K、24K/18K、16K/12K（总上限/压缩阈值）；
- Opus 相对全历史基线 −3.7～+5.6pt、GPT −3.3～+4.4pt；**22 个阈值配置中最多 5 个损失 >2pt**；
- 成本降低 Opus 2.2×–8.8×、GPT 2.4×–5.0×；
- **关键归因**：长输入任务的巨大收益主要来自**选择性读取**而非压缩（NIAH/Counting-Stars 零压缩，RULER 中位压缩 0）——不要把压缩当万能药；
- 反例：Qwen 3 Coder Next 在 16K/12K 从 53.0% 崩到 3.6%（verbose 轨迹无工作空间）→ 压缩阈值须与 `maxOutputBytes` 联动。

### 3.3 SSSM（§5.1）与良好压缩（Appendix A/G）

- **SSSM 五步**：理解对话状态自然语言描述 → 推理下一步 → 执行动作 → 登记结果 → 更新描述，使另一个独立推理实例可续接。关键是与黑盒 SSM 不同，状态是**可解释自然语言**；
- **SAC（单动作压缩）**：每上下文只做一个动作，峰值上下文从 130–200K 降到 **15–37K**（中位 7–9K），精度基本保持；
- **良好压缩不是叙事摘要，而是执行简报**：逐字任务副本 + 当前 occupation/意图/下一步 + 所有相关工件（计划、完成 requirements、指针）；Appendix G.1 六段结构：Objective / Established facts（区分 observation vs unverified）/ Applied changes / Verification / Dead ends / Remaining plan。

## 4 建议汇总（SE-M / CT-*）

> 层：L1 通用框架 / L2 Agent 框架 / L3 应用 / 仅参考。SE-M 延续自演化编号；CT-* 为本轮压缩/性能编号。

### 来自 Meta-Harness

| ID | 层 | 落点 | 建议 |
| --- | --- | --- | --- |
| SE-M1 | L1 | observability.md §3/§8 | 完整证据落盘：每候选一目录（code/scores/traces），span 不只进 OTLP |
| SE-M2 | L1/L2 | observability.md §5、plugin-system.md §5 | 区分两类压缩：对话可压、evidence store 禁止有损摘要；Redactor 只脱敏不裁剪 |
| SE-M3 | L1 | observability.md §8、capability-reservation.md | **非马尔可夫历史检索 seam**：`experience.query({candidate,kind,regex})` + 查询 CLI（当前最大缺口） |
| SE-M4 | L2 | plugin-system.md §8.1 | harness-as-plugin-set 可编辑面（单文件不可照搬） |
| SE-M5 | L2 | plugin-system.md §4/§8.3 | skill-as-steering：只约束输出与安全，不约束诊断过程 |
| SE-M6 | L2 | plugin-system.md §8.2 | Pareto frontier 晋升（多目标），test 只在 frontier 评一次 |
| SE-M7 | L2 | tools-and-policies.md §7 | 多目标 fitness（accuracy + context cost） |
| SE-M8 | L2 | plugin-system.md §8.3 | tripwire 扩两类泄漏（test 结果 / task-specific 字符串） |
| SE-M9 | L1 | api-and-testing.md | 轻量验证门禁（import+实例化+小样本）先于昂贵 eval |
| SE-M10 | L1+L2 | components.md §8 | 评估外置为独立服务，与 live/replay 对偶合并 |
| SE-M11 | L2（研究轨） | plugin-system.md §8.2 | 泛化作为晋升条件（未见模型/数据集验证） |
| SE-M12 | L3/参考 | roadmap.md | 搜索集构造纪律（baseline 打不穿、50–100 样本、快评优先） |
| SE-M13 | L2 | capability-reservation.md | 跨运行经验迁移（导入外部工件 warm-start） |
| SE-M14 | 仅参考 | recursive-self-evolution.md | 因果推理优先：隔离 confound → 纯增量 → 组合 |

### 来自短上下文论文

| ID | 层 | 落点 | 建议 |
| --- | --- | --- | --- |
| CT-1 | L1/L2 | engineering.md §9.2 | `maxContextTokens` 拆为 `totalContextLimit` + `compactionThreshold` 双阈值 + `peakLiveContextTokens` 指标 |
| CT-2 | L2 | plugin-system.md §5、state-and-events.md §11 | 压缩产物为 **typed recap schema**（六段），非自由文本摘要 |
| CT-3 | L1 | framework-model.md §6.1b、AS-9 | surface `replace` 做成压缩事务：Offloader 外置为 `workspace:///` 再原子替换为带指针 recap |
| CT-4 | L1 | framework-model.md §5.1 | session 记录压缩血缘（threshold/recap/URI/前 token 数），支持审计 |
| CT-5 | L2 | state-and-events.md §10 | 压缩纳入 `agent_end` awaited listener 屏障，落盘先于 resolve |
| CT-6 | L1/L2 | observability.md §4/§7 | 旁路 metric：live/peak token、压缩次数、估算成本（标注估算非实测） |
| CT-7 | L2 | state-and-events.md §11 | 压缩后 replay 语义：`safe` 需幂等可重建，否则写入已验证事实 |
| CT-8 | L2 | plugin-system.md §5 | 双模式：EoCC（阈值触发）默认 + SAC（每动作）实验；阈值与 `maxOutputBytes` 联动 |
| CT-9 | L2 | tools-and-policies.md §7 | 选择性读取一等工具：`doc-read`(6000/8000)、`grep -n`、`doc-stats` 等 |
| CT-10 | L3 | tui.md §4、engineering.md §9.2 | Debug HUD 增"上下文预算"面板 |
| CT-11 | 仅参考 | plugin-system.md §8.1 | SSSM 作为语义状态理论锚点（可解释自然语言，预留续接接口） |
| CT-12 | L1 | framework-model.md §6.1b | recap 唯一写入者仍是 Session 服务，压缩插件只产 proposal |

## 5 诚实的边界

1. "7x" 是货币成本/吞吐换算（256K vs 16K, Qwen），**不是延迟**；本地延迟约 2x；
2. 成本倍数是**估算模型**（Appendix B），依赖特定硬件/价格/1024-token 假设，不可当真实账单；
3. Meta-Harness 主实验只用 Claude Code 一个 proposer；GPT-OSS-20B 承担 search 选择，严格 held-out 是另外 4 个模型；
4. Table 2 的 11.4K tokens 与 Table 9 的 45.5K characters 单位不同；
5. 短上下文主实验只在 Opus 4.5 / GPT 5.6 Sol + 极简 Bash ReAct harness；开源模型差异大且 Qwen 3 Coder Next 在紧阈值崩塌；
6. 两篇论文都**不主张**长上下文永远无用或所有任务都能短上下文解决；
7. Meta-Harness 依赖真实 search-set 评估，不能套用 DREAM-RSI 的 FrozenStore 冻结重放做评分。

## 6 交叉引用与验证

| 本文结论 | 上游来源 | 下游落点 |
| --- | --- | --- |
| 完整轨迹优于摘要 | Meta-Harness Table 3 | observability.md SE-M1/M2 |
| 非马尔可夫检索缺口 | Meta-Harness §3/Table 8 | SE-M3（新增 seam） |
| 双阈值 + peak 指标 | 短上下文 §2.4.1 | engineering.md §9.2 CT-1 |
| Typed recap | 短上下文 Appendix A/G | plugin-system.md §5 CT-2 |
| 压缩事务 + 血缘 | 短上下文 §3.1 | framework-model.md CT-3/4 |

**总索引**：[README.md](../README.md)　|　**事实登记**：[fact-registry.md](../architecture/fact-registry.md)
