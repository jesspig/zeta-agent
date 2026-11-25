import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertReportAcceptable,
  renderMarkdown,
  summarizeReport,
} from "../packages/testing/src/quality-gates.ts";
import { readConfig, root, run, writeJson } from "./gate-lib.mjs";

const config = readConfig();
const order = ["tests", "security", "performance", "authenticity", "platform", "supply-chain"];
const only = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1];
const selected = only === undefined ? order : order.filter((name) => name === only);
if (selected.length === 0) throw new Error(`UNKNOWN_GATE_GROUP: ${only}`);

const gates = [];
const commandLog = [];
for (const name of selected) {
  const script = `scripts/gate-${name}.mjs`;
  console.log(`\n===== [${name}] bun ${script} =====`);
  const result = run("bun", [script]);
  commandLog.push({ name, command: `bun ${script}`, code: result.code, durationMs: result.durationMs });
  console.log(result.out.trim());
  console.log(`----- [${name}] exit=${result.code} -----`);
  const path = join(root, "reports", `gates-${name}.json`);
  if (!existsSync(path)) throw new Error(`GATE_REPORT_MISSING: ${path}`);
  const produced = JSON.parse(readFileSync(path, "utf8"));
  if (result.code !== 0 && !produced.some((gate) => gate.status === "fail")) {
    gates.push({
      id: `${name}:exit`,
      category: name === "supply-chain" ? "supply-chain" : name,
      name: `${name} 脚本退出`,
      status: "fail",
      scope: "local",
      detail: `脚本退出码 ${result.code} 但产物中无 fail 门`,
      evidence: [{ kind: "command", ref: `bun ${script}` }],
    });
  }
  for (const gate of produced) gates.push(gate);
}

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
  },
  gates,
};
writeJson("reports/quality-gates-report.json", report);
writeJson("reports/quality-gates-commands.json", {
  generatedAt: report.generatedAt,
  commands: commandLog,
});
const markdown = renderMarkdown(report);
mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "quality-gates-report.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
process.stdout.write(`\n${markdown}\n`);

const summary = summarizeReport(report);
console.log(
  `\n汇总: pass=${summary.pass} fail=${summary.fail} skipped=${summary.skipped} unverified=${summary.unverified}`
);
try {
  assertReportAcceptable(report);
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
}
if (summary.fail > 0) process.exit(1);
