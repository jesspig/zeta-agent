/**
 * RED-18（T-24，本地 fixture，不访问外网）：
 * 12 target 的构建矩阵与运行矩阵分离且 skipped/emulated 不冒充 native pass；
 * verifyArtifactBytes 拒绝缺失/超长/未声明的嵌入字节（含 arch-marker）；
 * staged release 在 digest/config/readiness 校验后原子切换 current，
 * 启动失败或探针不匹配自动恢复上一版，upgrade/rollback 日志可复核。
 */
const failures = [];
const evidence = [];

function manifestFixture(bytesById) {
  const ids = ["arch-marker", "resource-catalog", "system-prompt", "skills-index", "config-schema"];
  const embedded = ids.map((id) => ({
    id,
    kind: id === "arch-marker" ? "native" : "data",
    arch: id === "arch-marker" ? "x64" : "universal",
    path: `${id}.zetaasset`,
    bytes: bytesById[id].byteLength,
    sha256: require_sha256(bytesById[id]),
  }));
  return {
    version: 1,
    target: "linux-x64",
    binary: { arch: "x64", path: "zeta", bytes: 0 },
    embedded,
  };
}

function require_sha256(bytes) {
  return globalThis.__zetaSha256(bytes);
}

async function probe() {
  const { createHash } = await import("node:crypto");
  globalThis.__zetaSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const { TARGETS } = await import("../../packages/deploy/src/targets.ts");
  const { verifyArtifactBytes } = await import("../../packages/deploy/src/artifact.ts");
  const { collectTargetEvidence, emulateStartupFromArtifact } = await import(
    "../../packages/deploy/src/target-evidence.ts"
  );
  const { installRelease, stageRelease, readReleaseLog } = await import(
    "../../packages/deploy/src/lifecycle.ts"
  );

  // --- A. 完整 embedded bytes：逐项校验 bytes/SHA-256，不用合成 marker 替代 ---
  const nativeMarker = new Uint8Array(20);
  nativeMarker.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], 0);
  new DataView(nativeMarker.buffer).setUint16(18, 0x3e, true);
  const bytesById = Object.fromEntries(
    ["arch-marker", "resource-catalog", "system-prompt", "skills-index", "config-schema"].map((id) => [
      id,
      id === "arch-marker" ? nativeMarker : new TextEncoder().encode(`real-fixture-bytes:${id}`),
    ])
  );
  const fixture = manifestFixture(bytesById);
  let threw = false;
  try {
    verifyArtifactBytes(fixture, { ...bytesById });
  } catch {
    threw = true;
  }
  if (threw) failures.push("complete-embedded-bytes-rejected");

  for (const [label, mutate] of [
    ["missing", (m) => delete m["config-schema"]],
    ["wrong-length", (m) => (m["skills-index"] = new TextEncoder().encode("short"))],
    ["undeclared", (m) => (m["synthetic-marker"] = new TextEncoder().encode("fake"))],
  ]) {
    const partial = { ...bytesById };
    mutate(partial);
    let rejected = false;
    try {
      verifyArtifactBytes(fixture, partial);
    } catch {
      rejected = true;
    }
    if (!rejected) failures.push(`incomplete-embedded-bytes-accepted:${label}`);
  }
  evidence.push("embedded-bytes: complete=ok missing/wrong-length/undeclared=rejected");

  // --- B. 12 target 构建/运行矩阵分离，emulated/skipped 不冒充 native pass ---
  const loadArtifact = (target) => ({
    target,
    manifest: { ...fixture, target },
    embedded: bytesById,
  });
  const runNative = () => ({ code: 0, stdout: "zeta 0.1.0", probe: true });
  const matrix = collectTargetEvidence({
    host: "linux-x64",
    loadArtifact,
    runNative,
    now: () => "2026-11-26T00:00:00Z",
  });
  if (matrix.build.length !== 12 || matrix.run.length !== 12) {
    failures.push(`matrix-lengths build=${matrix.build.length} run=${matrix.run.length}`);
  }
  if (TARGETS.some((t) => !matrix.build.some((item) => item.target === t))) {
    failures.push("build-matrix-missing-target");
  }
  if (TARGETS.some((t) => !matrix.run.some((item) => item.target === t))) {
    failures.push("run-matrix-missing-target");
  }
  const native = matrix.run.filter((item) => item.mode === "native");
  if (native.length !== 1 || native[0]?.status !== "pass" || native[0]?.native !== true) {
    failures.push(`native-run-count=${native.length}`);
  }
  for (const item of matrix.run) {
    if (item.mode === "native") continue;
    if (item.status === "pass" || item.native === true) failures.push(`non-native-claimed-pass:${item.target}`);
    if (item.mode === "emulated" && (item.emulated !== true || item.native !== false)) {
      failures.push(`emulated-not-marked:${item.target}`);
    }
  }
  const emulated = emulateStartupFromArtifact(fixture, bytesById, { target: "linux-arm64" });
  if (emulated.status !== "emulated" || emulated.native !== false || emulated.mode !== "emulated") {
    failures.push(`emulation-status=${JSON.stringify(emulated.status)}`);
  }
  if ((emulated.checks ?? []).length < 5) failures.push(`emulation-checks=${(emulated.checks ?? []).length}`);
  evidence.push(
    `matrix build=${matrix.build.length} run=${matrix.run.length} native=${native.length} emulated=${matrix.run.filter((i) => i.mode === "emulated").length}`
  );

  // --- C. staged release：原子切换 + 失败自动回滚 + 可复核日志 ---
  class MemoryStore {
    constructor() {
      this.files = new Map();
      this.renames = [];
    }
    read(path) {
      const value = this.files.get(path);
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return value;
    }
    write(path, data) {
      this.files.set(path, data);
    }
    exists(path) {
      return this.files.has(path);
    }
    remove(path) {
      this.files.delete(path);
    }
    rename(from, to) {
      const value = this.files.get(from);
      if (value === undefined) throw new Error(`ENOENT ${from}`);
      this.files.delete(from);
      this.files.set(to, value);
      this.renames.push(`${from}->${to}`);
    }
  }
  const releaseManifest = (target = "linux-x64") => ({
    version: 1,
    target,
    binary: { arch: target.includes("arm64") ? "arm64" : "x64", path: "zeta", bytes: 3, sha256: globalThis.__zetaSha256(new Uint8Array([1, 2, 3])) },
    embedded: [],
  });
  const root = "/staged";
  const store = new MemoryStore();
  const logs = [];
  installRelease(root, "1.0.0", releaseManifest(), store);

  // 成功升级消耗第 1/2 次 readiness，升级消耗第 3 次预检、第 4 次提交后探针（失败）。
  let readinessCalls = 0;
  const readiness = () => {
    readinessCalls += 1;
    return readinessCalls !== 4;
  };
  const ok = await stageRelease(root, "2.0.0", releaseManifest("linux-arm64"), store, {
    probe: { startup: () => true, readiness },
    log: (event) => logs.push(event),
  });
  if (ok.rolledBack !== false) failures.push("staged-success-rolled-back");
  if (ok.digest === undefined || ok.configDigest === undefined) failures.push("staged-digest-missing");
  if (!store.renames.some((entry) => entry.includes("current.json.tmp->") && entry.includes("current.json"))) {
    failures.push(`atomic-switch-missing:${JSON.stringify(store.renames)}`);
  }
  if (!logs.some((event) => event.action === "switch")) failures.push("switch-log-missing");

  const beforeRollback = store.read(`${root}/current.json`);
  const bad = await stageRelease(root, "3.0.0", releaseManifest("linux-x64"), store, {
    probe: { startup: () => true, readiness },
    log: (event) => logs.push(event),
  });
  if (bad.rolledBack !== true) failures.push("probe-mismatch-did-not-rollback");
  if (store.read(`${root}/current.json`) !== beforeRollback) failures.push("rollback-pointer-not-restored");
  if (!logs.some((event) => event.action === "rollback")) failures.push("rollback-log-missing");
  if (readReleaseLog(store, root).length < logs.length) failures.push("release-log-not-auditable");
  evidence.push(`staged: switch=atomic rollback=auto log=${logs.length}`);

  return {
    green: failures.length === 0,
    actual: failures.length === 0 ? "T-24 矩阵分离/完整字节/原子发布与回滚全部通过" : failures,
    reason: failures.length === 0 ? "无 skipped/pass 混写、无合成 marker、回滚真实恢复" : "存在 T-24 实现缺口",
    evidence: evidence.join(" | "),
  };
}

export default {
  id: "RED-18",
  expectation:
    "12 target 构建矩阵与运行矩阵分离，native/emulated/skipped 如实标注；verifyArtifactBytes 拒绝缺失或伪造的 embedded bytes；staged release 先校验后原子切换并在探针不匹配时自动恢复上一版，日志可复核",
  probe,
};
