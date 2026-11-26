/**
 * T-23 真实 PTY 门：本机三场景必须真实通过（不 skip、不合成 escape 序列）。
 * 非宿主平台显式 skipped，交给 CI 三平台运行矩阵，不计为 pass。
 *
 * 用法：bun scripts/gate-pty.mjs
 */
import { checkPtyResult, runAllPtyScenarios } from "../packages/tui/src/pty-real.ts";
import { makeGate, readConfig, root, writeEvidence, writeGates } from "./gate-lib.mjs";

const config = readConfig();
const results = await runAllPtyScenarios({ cwd: root });
const gates = [];

for (const result of results) {
  const failures = checkPtyResult(result);
  const evidence = writeEvidence(
    `pty-${result.platform}-${result.scenario}`,
    [
      `platform=${result.platform} scenario=${result.scenario} exitCode=${result.exitCode}`,
      `alternate-enter=${result.enteredAlternate} alternate-restore=${result.restoredAlternate}`,
      `raw-mode-markers=${result.rawModeMarkers} resize=${result.resizeSequence}`,
      "--- RAW PTY BYTES ---",
      result.raw,
    ].join("\n"),
  );
  gates.push(
    makeGate({
      id: `pty:host-${result.scenario}`,
      category: "pty",
      name: `宿主真实 PTY：${result.scenario}`,
      status: failures.length === 0 ? "pass" : "fail",
      scope: "local",
      exitCode: result.exitCode,
      detail: failures.length === 0
        ? `platform=${result.platform} exit=${result.exitCode}；备用屏/raw/退出${result.scenario === "resize" ? "/resize" : ""}${result.scenario === "abnormal" ? "/异常复位" : ""}均由真实子进程输出验证`
        : failures.join("；"),
      evidence: [{ kind: "file", ref: evidence }],
    }),
  );
}

const hostLabels = { win32: "windows-latest", darwin: "macos-latest", linux: "ubuntu-latest" };
const hostLabel = hostLabels[process.platform];
for (const platform of config.supplyChain.ciPlatforms) {
  if (platform === hostLabel) continue;
  gates.push(
    makeGate({
      id: `pty:cross-${platform}`,
      category: "pty",
      name: `跨宿主真实 PTY：${platform}`,
      status: "skipped",
      scope: "cross-platform",
      detail: `本机 ${process.platform} 无法运行 ${platform} 的运行态；由 CI 三平台矩阵覆盖，skipped 不计为 pass`,
      evidence: [{ kind: "config", ref: config.supplyChain.requiredCiWorkflow }],
    }),
  );
}

writeGates("pty", gates);
for (const gate of gates) {
  console.log(`${gate.status.toUpperCase()} ${gate.id}: ${gate.detail}`);
}
if (gates.some((gate) => gate.status === "fail")) process.exit(1);
