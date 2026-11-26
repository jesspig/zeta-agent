/**
 * T-24：12 target 可复现运行证据。构建矩阵（cross-build/static）与运行矩阵
 * （native / emulated / skipped）分开生成，emulated 与 skipped 永不写成 pass。
 *
 * 运行：bun scripts/target-evidence.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTargetEvidence } from "../packages/deploy/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reports = join(root, "reports");

function render(matrix) {
  const lines = [
    "# 12 target 运行态证据矩阵（T-24）",
    "",
    `- Schema：\`${matrix.schema}\``,
    `- 生成时间：${matrix.generatedAt}`,
    `- 宿主 target：${matrix.host}`,
    `- 构建矩阵：pass=${matrix.summary.build.pass} skipped=${matrix.summary.build.skipped} fail=${matrix.summary.build.fail}`,
    `- 运行矩阵：native=${matrix.summary.run.native} emulated=${matrix.summary.run.emulated} skipped=${matrix.summary.run.skipped} fail=${matrix.summary.run.fail}`,
    "",
    "## 构建矩阵（cross-build/static，不声明 native 运行）",
    "",
    "| target | bun target | 状态 | 逐项校验 | SHA-256 | 明细 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...matrix.build.map(
      (item) =>
        `| ${item.target} | ${item.bunTarget} | ${item.status} | ${item.artifactVerified ? "yes" : "no"} | ${item.digest?.slice(0, 12) ?? "n/a"} | ${item.detail.replaceAll("|", "\\|")} |`
    ),
    "",
    "## 运行矩阵（native / emulated / skipped 分列）",
    "",
    "| target | 模式 | 状态 | native | emulated | 证据来源 | 明细 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...matrix.run.map(
      (item) =>
        `| ${item.target} | ${item.mode} | ${item.status} | ${item.native ? "true" : "false"} | ${item.emulated ? "true" : "false"} | ${item.proof} | ${item.detail.replaceAll("|", "\\|")} |`
    ),
    "",
    "## 诚实性声明",
    "",
    ...matrix.honesty.map((note) => `- ${note}`),
    "",
  ];
  return lines.join("\n");
}

const matrix = collectTargetEvidence();
mkdirSync(reports, { recursive: true });
writeFileSync(join(reports, "target-evidence.json"), `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
writeFileSync(join(reports, "target-evidence.md"), render(matrix), "utf8");
for (const item of matrix.build) console.log(`BUILD ${item.status.toUpperCase()} ${item.target}: ${item.detail}`);
for (const item of matrix.run) {
  console.log(`RUN ${item.status.toUpperCase()} ${item.target} mode=${item.mode} native=${item.native}: ${item.detail}`);
}
console.log(
  `target-evidence: build pass=${matrix.summary.build.pass} skipped=${matrix.summary.build.skipped} fail=${matrix.summary.build.fail} | run native=${matrix.summary.run.native} emulated=${matrix.summary.run.emulated} skipped=${matrix.summary.run.skipped} fail=${matrix.summary.run.fail}`
);
process.exit(matrix.summary.build.fail > 0 || matrix.summary.run.fail > 0 ? 1 : 0);
