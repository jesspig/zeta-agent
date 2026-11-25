/**
 * T-27：生成 A1–A40 最终验收报告。
 *
 * 每一项都实际执行命令并把原始输出落盘到 reports/evidence/acceptance/Axx.log；
 * 命令失败、预期标记缺失或证据文件不存在一律 fail，不把 unavailable 当成 pass。
 * 运行：bun scripts/acceptance-report.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = join(ROOT, "reports/evidence/acceptance");
const REPORT_DIR = join(ROOT, "reports");
const BUN = process.execPath;

const ITEMS = [
  { id: "A1", title: "build/typecheck/test 全绿、lockfile、依赖图无环", commands: [
    { args: ["run", "check"], expect: "45 successful" },
    { args: ["x", "turbo", "run", "typecheck", "--force"], expect: "15 successful" },
    { args: ["test"], expect: "0 fail" },
  ] },
  { id: "A2", title: "事实登记 P1-P10 指向实现与测试", commands: [
    { args: ["scripts/check-fact-registry.mjs"], expect: "P1-P10 均指向" },
  ] },
  { id: "A3", title: "同配置不同顺序观察等价（Thm 80）", commands: [
    { args: ["test", "packages/testing/src/properties.spec.ts", "packages/components/loader/src/config.spec.ts", "packages/components/loader/src/reconcile.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A4", title: "随机装卸无残留、逆各一次（Cor 69）", commands: [
    { args: ["test", "packages/testing/src/properties.spec.ts", "packages/components/cordis/src/fiber.spec.ts", "packages/components/cordis/src/effect.cleanup.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A5", title: "guard teardown 可读依赖、撤回延迟（Thm 70）", commands: [
    { args: ["test", "packages/framework/src/context.lifecycle.spec.ts", "packages/testing/src/properties.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A6", title: "12 条不变量 legacy/plugin 双版 + 双门", commands: [
    { args: ["test", "packages/agent-framework/src/runtime/invariants.spec.ts", "packages/agent-framework/src/runtime/invariants-naming.spec.ts", "packages/agent-framework/src/tools/invariants.spec.ts"], expect: "0 fail" },
    { args: ["scripts/check-invariant-points.mjs"] },
  ] },
  { id: "A7", title: "工具热插拔声明同步；权限热更新不 reload", commands: [
    { args: ["test", "packages/framework/src/loader/plugin-transaction.spec.ts", "packages/agent/src/facade.tool-boundary.spec.ts", "packages/agent/src/plugins/permissions/policy.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A8", title: "工具副作用分类审查与默认发射策略", commands: [
    { args: ["test", "packages/agent/src/tools.spec.ts", "packages/components/security/src/emission.spec.ts", "packages/components/security/src/egress.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A9", title: "testRender 帧快照覆盖消息/工具/状态/overlay/槽位", commands: [
    { args: ["test", "packages/tui/src/runtime.spec.tsx", "packages/tui/src/components/transcript.visual.spec.tsx", "packages/tui/src/approval-ui.spec.tsx", "packages/tui/src/slots.spec.ts", "packages/tui/src/create-tui.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A10", title: "--print/--json/--rpc 无 TTY 可用", commands: [
    { args: ["test", "apps/zeta-cli/src/headless-isolation.spec.ts", "apps/zeta-cli/src/print-e2e.spec.ts", "packages/agent/src/cli/modes.spec.ts", "packages/agent/src/cli/modes.failure.spec.ts", "packages/deploy/src/rpc.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A11", title: "HMR 真实插件替换、失败保留旧 artifact/FAILED 重试", commands: [
    { args: ["test", "packages/agent/src/plugins/hot-reload.e2e.spec.ts", "apps/zeta-cli/src/hot-reload.spec.ts", "packages/components/loader/src/hmr.spec.ts", "packages/agent/src/extensions/hot-reload.e2e.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A12", title: "自修改候选隔离构建/exports/依赖环/能力审查", commands: [
    { args: ["test", "packages/agent/src/extensions/loader.generation.spec.ts", "packages/framework/src/loader/extension-policy.spec.ts", "packages/framework/src/loader/plugin-transaction.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A13", title: "五模式派发与单调 guard", commands: [
    { args: ["test", "packages/components/events/src/events.spec.ts", "packages/agent-framework/src/runtime/agent.spec.ts", "packages/agent-framework/src/tools/pipeline.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A14", title: "配置顺序汇合与 patch 整块替换", commands: [
    { args: ["test", "packages/components/loader/src/config.spec.ts", "packages/deploy/src/canonical.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A15", title: "durable 双崩溃窗口与幂等 adapter", commands: [
    { args: ["test", "packages/agent/src/plugins/effects/durable.crash.spec.ts", "packages/components/security/src/outbox.spec.ts", "packages/components/security/src/emission.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A16", title: "晋升单调性：仅严格更优且资格合格替换", commands: [
    { args: ["test", "packages/agent/src/research/promotion.spec.ts", "packages/agent/src/research/guardrails.spec.ts", "packages/agent/src/research/decision.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A17", title: "重放不变量 budget/order/legal/best", commands: [
    { args: ["test", "packages/agent/src/research/frozen.spec.ts", "packages/agent/src/research/pipeline.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A18", title: "观察等价晋升：typed recap 六段与外置取回", commands: [
    { args: ["test", "packages/agent-framework/src/session/surface.spec.ts", "packages/agent-framework/src/session/recap.spec.ts", "packages/agent/src/facade.compaction.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A19", title: "grader 信息不进改进上下文，tripwire 抛错", commands: [
    { args: ["test", "packages/agent/src/facade.a21a22.spec.ts", "packages/tui/src/osc-security.spec.ts", "packages/components/observability/src/index.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A20", title: "自演化前后 24 条不变量全绿", commands: [
    { args: ["test", "packages/agent/src/research/promotion.spec.ts", "packages/agent-framework/src/runtime/invariants.spec.ts", "packages/agent-framework/src/tools/invariants.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A21", title: "可观测性归因/脱敏/OTLP 降级/汇合不变", commands: [
    { args: ["test", "packages/framework/src/context.tenant.spec.ts", "packages/agent/src/facade.tenant.spec.ts", "packages/agent/src/tenant/governance.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A22", title: "ExecutionBackend 强制、capability 降级 FAILED、凭证不入日志", commands: [
    { args: ["test", "packages/agent/src/tools/backend.contract.spec.ts", "packages/components/security/src/backend.matrix.spec.ts", "packages/components/security/src/credentials.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A23", title: "egress 默认拒绝、进程外审计完整性标记", commands: [
    { args: ["test", "packages/components/security/src/egress.dataplane.spec.ts", "packages/components/security/src/audit.integrity.spec.ts", "packages/components/security/src/audit.socket.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A24", title: "Cordis 官方源码对照（@mode/HMR/两层撤销）", commands: [
    { args: ["test", "packages/components/cordis/src/reflect.spec.ts", "packages/components/cordis/src/fiber.spec.ts", "packages/components/loader/src/hmr.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A25", title: "Effect 4 形态/Impl/6 态/AgentPluginApi 可编译", commands: [
    { args: ["x", "turbo", "run", "typecheck", "--force"], expect: "15 successful" },
  ] },
  { id: "A26", title: "typed recap、workspace:/// 取回、双阈值与 peak", commands: [
    { args: ["test", "packages/agent-framework/src/session/offload.t12.spec.ts", "packages/agent/src/facade.compaction.spec.ts", "packages/agent/src/session/store.conformance.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A27", title: "经验检索与完整 evidence 落盘", commands: [
    { args: ["test", "packages/agent/src/research/experience.spec.ts", "packages/agent/src/research/experience-library.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A28", title: "多租户 realm 隔离与配额 coeffect", commands: [
    { args: ["test", "packages/agent/src/tenant/object-distribution.spec.ts", "packages/agent/src/tenant/object-host.spec.ts", "packages/components/capabilities/src/quota.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A29", title: "fitness seam、A/B、回归门禁与实验隔离", commands: [
    { args: ["test", "packages/agent/src/research/fitness.spec.ts", "packages/deploy/src/fitness.spec.ts", "packages/deploy/src/fitness.budget-identity.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A30", title: "local/daemon/remote 真实拓扑、canonical digest、架构校验、gRPC", commands: [
    { args: ["test", "packages/deploy/src/daemon.spec.ts", "packages/deploy/src/remote.spec.ts", "packages/deploy/src/rpc.spec.ts", "packages/deploy/src/runtime-probes.spec.ts", "packages/deploy/src/artifact.spec.ts", "packages/deploy/src/canonical.spec.ts", "packages/deploy/src/targets.spec.ts", "packages/deploy/src/grpc.spec.ts"], expect: "0 fail" },
    { args: ["scripts/check-grpc-wire.mjs"] },
  ], note: "wire-level gRPC 由 proto 桩的真实 unary 往返覆盖" },
  { id: "A31", title: "package graph 无环且跨包相对 import 被拒", commands: [
    { args: ["scripts/check-core-dependencies.mjs"] },
    { args: ["scripts/guard-architecture.mjs"] },
    { args: ["test", "scripts/guard-architecture.spec.mjs"], expect: "0 fail" },
    { args: ["scripts/check-facade-exports.mjs"] },
    { args: ["scripts/check-aggregate-exports.mjs"] },
  ] },
  { id: "A32", title: "公开 API 无未实现 stub / 静默 no-op", commands: [
    { args: ["scripts/check-api-stubs.mjs"], expect: "无未实现标记" },
    { args: ["scripts/check-facade-exports.mjs"] },
    { args: ["test", "packages/agent/src/facade.security-backend.spec.ts", "packages/components/security/src/backend.unconnected.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A33", title: "持久化三类崩溃与未知结果可恢复", commands: [
    { args: ["test", "packages/agent/src/session/jsonl.store.spec.ts", "packages/agent/src/session/sqlite.store.spec.ts", "packages/agent/src/plugins/effects/durable.crash.spec.ts", "packages/components/security/src/outbox.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A34", title: "run/tool/session 并发生命周期完备", commands: [
    { args: ["test", "packages/agent-framework/src/runtime/core.lifecycle.spec.ts", "packages/agent-framework/src/runtime/loop.lifecycle.spec.ts", "packages/agent/src/facade.cancellation.spec.ts", "packages/agent/src/session/tree.atomic.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A35", title: "文件/进程/网络/凭证/审计由真实边界强制", commands: [
    { args: ["test", "packages/agent/src/tools/backend.contract.spec.ts", "packages/components/security/src/egress.dataplane.spec.ts", "packages/components/security/src/vault.ownership.spec.ts", "packages/components/security/src/audit.integrity.spec.ts", "packages/components/security/src/emission.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A36", title: "local/daemon/remote 与三平台 12 target 矩阵", commands: [
    { args: ["scripts/gate-platform.mjs"] },
    { args: ["scripts/smoke-local.ts"], expect: "PASS rollback" },
    { args: ["scripts/release-check.mjs"] },
  ], note: "本机仅 win32-x64 可运行；11 个非宿主 target 为 skipped，不计 pass，待 CI 裁决" },
  { id: "A37", title: "Provider/MCP/RPC/CLI conformance 全绿", commands: [
    { args: ["test", "packages/agent/src/providers/conformance.spec.ts", "packages/agent/src/plugins/mcp/conformance.spec.ts", "packages/deploy/src/rpc.spec.ts", "apps/zeta-cli/src/print-e2e.spec.ts", "apps/zeta-cli/src/args.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A38", title: "性能预算与资源增长回归门", commands: [
    { args: ["scripts/gate-performance.mjs"], expect: "PASS perf-budget" },
    { args: ["test", "packages/deploy/src/budget.spec.ts", "packages/deploy/src/budget.fields.spec.ts"], expect: "0 fail" },
  ] },
  { id: "A39", title: "文档能力矩阵与代码装配自动一致", commands: [
    { args: ["scripts/check-capability-matrix.mjs"], expect: "装配清单一致" },
    { args: ["scripts/check_docs_links.mjs"], expect: "0 断链" },
  ] },
  { id: "A40", title: "研究轨所有晋升路径强制经过四道护栏", commands: [
    { args: ["test", "packages/agent/src/research/guardrails.spec.ts", "packages/agent/src/research/promotion.spec.ts", "packages/agent/src/research/decision.spec.ts", "packages/deploy/src/fitness.budget-identity.spec.ts"], expect: "0 fail" },
  ] },
];

function sanitize(text) {
  const posixRoot = ROOT.replace(/\\/g, "/");
  return text
    .split(BUN).join("bun")
    .split(`file:///${posixRoot}/`).join("./")
    .split(`${posixRoot}/`).join("./")
    .split(ROOT).join(".")
    .replace(/[A-Za-z]:\\(?:[^\\]+\\)*zeta-agent\\/g, "./")
    .replace(/[A-Za-z]:\/(?:[^\/]+\/)*zeta-agent\//g, "./");
}

function summarize(output) {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /pass|fail|PASS|FAIL|SKIPPED|UNVERIFIED|successful|exit=|SHA-256|装配|断链|没有|无未实现/i.test(line));
  return lines.slice(-6).join(" | ") || "无匹配摘要行（见日志）";
}

function runCommand(spec) {
  const result = spawnSync(BUN, spec.args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const expected = spec.expect === undefined ? true : new RegExp(spec.expect).test(output);
  return { ok: result.status === 0 && expected, output: `${output}\nexit=${result.status ?? "null"}\n` };
}

function platformSkipDetail() {
  const path = join(ROOT, "reports/gates-platform.json");
  if (!existsSync(path)) return "gates-platform.json 缺失";
  const gates = JSON.parse(readFileSync(path, "utf8"));
  const skipped = gates
    .filter((gate) => gate.id?.startsWith("platform:") && gate.status !== "pass")
    .map((gate) => gate.id?.replace("platform:", "") ?? "unknown");
  return skipped.length === 0 ? undefined : `skipped=${skipped.length}: ${skipped.join(", ")}`;
}

export async function runAcceptance(ids = []) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const results = [];
  const selected = ids.length === 0 ? ITEMS : ITEMS.filter((item) => ids.includes(item.id));
  for (const item of selected) {
    const logs = [];
    const commands = [];
    let ok = true;
    for (const spec of item.commands) {
      const command = ["bun", ...spec.args].join(" ");
      commands.push(command);
      const executed = runCommand(spec);
      logs.push(`===== ${command} =====\n${executed.output}`);
      if (!executed.ok) ok = false;
    }
    let status = ok ? "pass" : "fail";
    let note = item.note;
    if (item.id === "A36") {
      const skipped = platformSkipDetail();
      if (skipped !== undefined) {
        status = "fail";
        note = `${item.note ?? ""}；证据：${skipped}`;
      }
    }
    const evidence = `reports/evidence/acceptance/${item.id}.log`;
    writeFileSync(join(ROOT, evidence), sanitize(logs.join("\n")), "utf8");
    results.push({
      id: item.id,
      title: item.title,
      status,
      commands,
      summary: summarize(logs.join("\n")),
      evidence,
      note,
    });
    console.log(`${status.toUpperCase()} ${item.id}: ${item.title}`);
  }
  return results;
}

export function renderAcceptanceMarkdown(results) {
  const pass = results.filter((item) => item.status === "pass").length;
  const fail = results.filter((item) => item.status === "fail").length;
  const lines = [
    "# A1–A40 最终验收报告",
    "",
    `- 基线：feature/release-quality-gates @ \`9b6f231\`（T-26 已提交）`,
    `- 结论：pass ${pass} / fail ${fail} / 共 ${results.length} 项`,
    "- 口径：每项均实际执行命令，原始输出见 `reports/evidence/acceptance/Axx.log`；未通过项不写 pass。",
    "",
    "| ID | 判据 | 结论 | 关键证据 | 说明 |",
    "| --- | --- | --- | --- | --- |",
    ...results.map((item) => {
      const detail = `${item.evidence}；${item.commands.map((c) => `\`${c}\``).join("、")}；${item.summary}`;
      return `| ${item.id} | ${item.title} | ${item.status.toUpperCase()} | ${detail.replace(/\|/g, "\\|")} | ${item.note ?? "—"} |`;
    }),
    "",
    "## 待裁决项",
    "",
    "- A36：本机仅 win32-x64 可安装/启动/升级/回滚，其余 11 个 target 在 `reports/gates-platform.json` 为 skipped，不能计 pass；需 CI 三平台矩阵补证。",
    "- 供应链：`reports/release-ages.json` 中 @opentui/solid、solid-js、turbo 过新（unverified），未改阈值；不属于 A 项 pass 依据。",
    "",
  ];
  return lines.join("\n");
}

export async function main() {
  const ids = process.argv.slice(2);
  const resultPath = join(REPORT_DIR, "acceptance-report.json");
  const previous = ids.length > 0 && existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : [];
  const updated = await runAcceptance(ids);
  const byId = new Map([...previous, ...updated].map((item) => [item.id, item]));
  const results = ITEMS.map((item) => byId.get(item.id)).filter((item) => item !== undefined);
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  writeFileSync(join(REPORT_DIR, "acceptance-report.md"), renderAcceptanceMarkdown(results), "utf8");
  const fail = results.filter((item) => item.status === "fail").map((item) => item.id);
  console.log(`acceptance: pass=${results.length - fail.length} fail=${fail.length} (${fail.join(", ")})`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
