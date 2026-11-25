import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  makeGate,
  readConfig,
  root,
  run,
  writeGates,
  writeJson,
} from "./gate-lib.mjs";
import { assertAuthenticityBaseline, scanAuthenticity } from "../packages/testing/src/quality-gates.ts";

const EXTENSIONS = [".spec.ts", ".test.ts", ".spec.tsx", ".test.tsx", ".spec.mjs", ".test.mjs"];

function collect(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "reports") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, output);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) output.push(full);
  }
  return output;
}

const sources = collect(root)
  .map((path) => ({
    path: relative(root, path).split(sep).join("/"),
    content: readFileSync(path, "utf8"),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

const scan = scanAuthenticity(sources);
if (process.argv.includes("--emit-baseline")) {
  process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
  process.exit(0);
}

writeJson("reports/test-authenticity.json", { generatedAt: new Date().toISOString(), scan, files: sources.map((item) => item.path) });
const config = readConfig();
const gates = [];
try {
  assertAuthenticityBaseline(scan, config.authenticity.baseline);
  gates.push(
    makeGate({
      id: "authenticity-ratchet",
      category: "authenticity",
      name: "去伪棘轮：公共 API / 真实异步 / 真实并行 / 真实故障注入",
      status: "pass",
      detail: `${scan.files} files / publicApi ${scan.publicApiImports} / async ${scan.realAsyncFiles} / parallel ${scan.parallelFiles} / fault ${scan.faultInjectionFiles} / mockOnly ${scan.mockOnlyFiles} / fakeTimer ${scan.fakeTimerFiles}`,
      evidence: [{ kind: "file", ref: "reports/test-authenticity.json" }],
    })
  );
} catch (error) {
  gates.push(
    makeGate({
      id: "authenticity-ratchet",
      category: "authenticity",
      name: "去伪棘轮",
      status: "fail",
      detail: error.message,
      evidence: [{ kind: "file", ref: "reports/test-authenticity.json" }],
    })
  );
}

for (const requirement of config.authenticity.requiredMarkers) {
  const source = sources.find((item) => item.path === requirement.file);
  const missing = source
    ? requirement.markers.filter((marker) => !source.content.includes(marker))
    : [`文件缺失: ${requirement.file}`];
  gates.push(
    makeGate({
      id: `authenticity:${requirement.file}`,
      category: "authenticity",
      name: `${requirement.kind} 去伪锚点`,
      status: missing.length === 0 ? "pass" : "fail",
      detail:
        missing.length === 0
          ? `${requirement.file} 命中 ${requirement.markers.join(", ")}`
          : `${requirement.file} 缺少 ${missing.join(", ")}`,
      evidence: existsSync(join(root, requirement.file))
        ? [{ kind: "file", ref: requirement.file }]
        : [],
    })
  );
}

/** 真实故障注入：临时目录中的文件被真实删除，观察进程必须报错。 */
const injection = run("bun", ["scripts/gate-inject-probe.mjs"]);
gates.push(
  makeGate({
    id: "authenticity:real-fault-injection",
    category: "authenticity",
    name: "真实故障注入探针",
    status: injection.code === 0 && injection.stdout.includes("INJECT_OK") ? "pass" : "fail",
    detail: `子进程退出码 ${injection.code}；${injection.stdout.trim() || injection.stderr.trim()}`,
    exitCode: injection.code,
    evidence: [{ kind: "command", ref: "bun scripts/gate-inject-probe.mjs" }],
  })
);

writeGates("authenticity", gates);
for (const item of gates) console.log(`${item.status.toUpperCase()} ${item.id}: ${item.detail}`);
if (gates.some((item) => item.status === "fail")) process.exit(1);
