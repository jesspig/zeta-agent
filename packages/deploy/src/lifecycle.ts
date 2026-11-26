import { verifyArtifactManifest, type ArtifactManifest } from "./artifact";
import { computeConfigDigest } from "./canonical";
import { computeStableConfigDigest } from "./config-digest";

export interface ReleaseStore {
  read(path: string): string;
  write(path: string, data: string): void;
  exists(path: string): boolean;
  remove?(path: string): void;
  /** 原子提交所需：同目录临时文件 rename 到目标路径；不提供则 staged release 失败关闭。 */
  rename?(from: string, to: string): void;
}

export interface Release {
  readonly version: string;
  readonly manifest: ArtifactManifest;
  readonly digest: string;
}

interface Pointer {
  readonly version: string;
  readonly digest: string;
}

const releasePath = (root: string, version: string): string => `${root}/releases/${version}/manifest.json`;
const pointerPath = (root: string): string => `${root}/current.json`;
const historyPath = (root: string): string => `${root}/history.json`;

function parse<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`MANIFEST_INVALID: ${label}: ${(error as Error).message}`);
  }
}

function readJson<T>(store: ReleaseStore, path: string, label: string): T {
  return parse<T>(store.read(path), label);
}

function readPointer(root: string, store: ReleaseStore): Pointer | undefined {
  if (!store.exists(pointerPath(root))) return undefined;
  return readJson<Pointer>(store, pointerPath(root), "current");
}

function readHistory(root: string, store: ReleaseStore): string[] {
  if (!store.exists(historyPath(root))) return [];
  const history = readJson<string[]>(store, historyPath(root), "history");
  if (!Array.isArray(history)) throw new Error("MANIFEST_INVALID: history");
  return history;
}

function writeState(root: string, store: ReleaseStore, version: string, digest: string, history: string[]): void {
  store.write(pointerPath(root), JSON.stringify({ version, digest }));
  store.write(historyPath(root), JSON.stringify(history));
}

export function currentRelease(root: string, store: ReleaseStore): Release {
  const pointer = readPointer(root, store);
  if (pointer === undefined) throw new Error("RELEASE_NOT_INSTALLED");
  const manifest = readJson<ArtifactManifest>(store, releasePath(root, pointer.version), pointer.version);
  verifyArtifactManifest(manifest);
  return { version: pointer.version, manifest, digest: pointer.digest };
}

export function installRelease(
  root: string,
  version: string,
  manifest: ArtifactManifest,
  store: ReleaseStore
): Release {
  verifyArtifactManifest(manifest);
  const previous = readPointer(root, store);
  if (previous?.version === version) throw new Error(`VERSION_EXISTS: ${version}`);
  const digest = computeConfigDigest(manifest as unknown as Record<string, unknown>);
  store.write(releasePath(root, version), JSON.stringify(manifest));
  writeState(root, store, version, digest, [...readHistory(root, store), version]);
  return { version, manifest, digest };
}

export function upgradeRelease(
  root: string,
  version: string,
  manifest: ArtifactManifest,
  store: ReleaseStore,
  log?: (event: ReleaseLogEvent) => void
): { from: string; to: string; digest: string } {
  const current = currentRelease(root, store);
  if (current.version === version) throw new Error(`VERSION_EXISTS: ${version}`);
  const installed = installRelease(root, version, manifest, store);
  appendReleaseLog(
    store,
    root,
    {
      at: Date.now(),
      action: "switch",
      from: current.version,
      to: installed.version,
      digest: installed.digest,
      detail: "upgradeRelease: 旧入口，未做 staged 探针校验",
    },
    log
  );
  return { from: current.version, to: installed.version, digest: installed.digest };
}

export function rollbackRelease(
  root: string,
  store: ReleaseStore,
  log?: (event: ReleaseLogEvent) => void
): { from: string; to: string; digest: string } {
  const current = currentRelease(root, store);
  const history = readHistory(root, store);
  if (history.length < 2) throw new Error("HISTORY_EMPTY");
  const target = history[history.length - 2]!;
  const manifest = readJson<ArtifactManifest>(store, releasePath(root, target), target);
  verifyArtifactManifest(manifest);
  const digest = computeConfigDigest(manifest as unknown as Record<string, unknown>);
  writeState(root, store, target, digest, history.slice(0, -1));
  appendReleaseLog(
    store,
    root,
    {
      at: Date.now(),
      action: "rollback",
      from: current.version,
      to: target,
      digest,
      detail: "rollbackRelease: 恢复上一版本",
    },
    log
  );
  return { from: current.version, to: target, digest };
}

// ---------------------------------------------------------------------------
// T-24 staged release：校验 → 暂存 → 原子切换 current → 提交后探针 → 失败自动恢复。
// ---------------------------------------------------------------------------

export type ReleaseLogAction =
  | "stage"
  | "verified"
  | "probe"
  | "switch"
  | "rollback"
  | "fail";

export interface ReleaseLogEvent {
  readonly at: number;
  readonly action: ReleaseLogAction;
  readonly from: string | null;
  readonly to: string;
  readonly digest: string;
  readonly configDigest?: string;
  readonly detail: string;
}

export interface ReleaseProbe {
  /** 新版本启动探针；false 或抛错即失败关闭，不切换 current。 */
  startup(release: Release): boolean | Promise<boolean>;
  /** readiness 探针；切换前后各执行一次，提交后不匹配自动恢复上一版。 */
  readiness(release: Release): boolean | Promise<boolean>;
}

export interface StagedReleaseOptions {
  readonly probe: ReleaseProbe;
  readonly expectedDigest?: string;
  readonly expectedConfigDigest?: string;
  readonly log?: (event: ReleaseLogEvent) => void;
}

export interface StagedReleaseResult {
  readonly from: string | null;
  readonly to: string;
  readonly digest: string;
  readonly configDigest: string;
  readonly rolledBack: boolean;
  readonly error?: string;
}

function logPath(root: string): string {
  return `${root}/release-log.jsonl`;
}

export function readReleaseLog(store: ReleaseStore, root: string): readonly ReleaseLogEvent[] {
  if (!store.exists(logPath(root))) return [];
  return store
    .read(logPath(root))
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as ReleaseLogEvent;
      } catch (error) {
        throw new Error(`RELEASE_LOG_INVALID: line ${index + 1}: ${(error as Error).message}`);
      }
    });
}

function appendReleaseLog(store: ReleaseStore, root: string, event: ReleaseLogEvent, sink?: (event: ReleaseLogEvent) => void): void {
  const events = readReleaseLog(store, root);
  store.write(logPath(root), [...events, event].map((item) => JSON.stringify(item)).join("\n") + "\n");
  sink?.(event);
}

function atomicWrite(store: ReleaseStore, path: string, data: string): void {
  if (store.rename === undefined) throw new Error("ATOMIC_RENAME_REQUIRED");
  const tmp = `${path}.tmp`;
  store.write(tmp, data);
  store.rename(tmp, path);
}

async function probeOrFalse(check: () => boolean | Promise<boolean>): Promise<{ ok: boolean; detail: string }> {
  try {
    const value = await check();
    return { ok: value === true, detail: value === true ? "ok" : "probe-returned-false" };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

/**
 * 先完成 manifest/digest/config/启动与 readiness 校验，再原子切换 current；
 * 切换后的 readiness 不匹配时立即恢复切换前的指针与历史，并留下可复核日志。
 */
export async function stageRelease(
  root: string,
  version: string,
  manifest: ArtifactManifest,
  store: ReleaseStore,
  options: StagedReleaseOptions
): Promise<StagedReleaseResult> {
  if (store.rename === undefined) throw new Error("ATOMIC_RENAME_REQUIRED");
  const previousRaw = store.exists(pointerPath(root)) ? store.read(pointerPath(root)) : undefined;
  const previousHistory = readHistory(root, store);
  const previous = readPointer(root, store);
  const emit = (action: ReleaseLogAction, to: string, digest: string, detail: string, configDigest?: string) => {
    appendReleaseLog(
      store,
      root,
      {
        at: Date.now(),
        action,
        from: previous?.version ?? null,
        to,
        digest,
        ...(configDigest === undefined ? {} : { configDigest }),
        detail,
      },
      options.log
    );
  };

  verifyArtifactManifest(manifest);
  const digest = computeConfigDigest(manifest as unknown as Record<string, unknown>);
  const configDigest = computeStableConfigDigest({
    target: manifest.target,
    version,
    digest,
  });
  if (previous?.version === version) throw new Error(`VERSION_EXISTS: ${version}`);
  if (options.expectedDigest !== undefined && options.expectedDigest !== digest) {
    emit("fail", version, digest, `STAGED_DIGEST_MISMATCH: expected ${options.expectedDigest}, got ${digest}`);
    throw new Error(`STAGED_DIGEST_MISMATCH: expected ${options.expectedDigest}, got ${digest}`);
  }
  if (options.expectedConfigDigest !== undefined && options.expectedConfigDigest !== configDigest) {
    emit("fail", version, digest, `STAGED_CONFIG_DIGEST_MISMATCH: expected ${options.expectedConfigDigest}, got ${configDigest}`, configDigest);
    throw new Error(`STAGED_CONFIG_DIGEST_MISMATCH`);
  }
  emit("stage", version, digest, `staged ${version}`, configDigest);
  emit("verified", version, digest, "manifest/digest/config 校验通过", configDigest);

  // 暂存：先写目标版本的 manifest，再校验探针；此时 current 仍指向上一版。
  atomicWrite(store, releasePath(root, version), JSON.stringify(manifest));
  const staged: Release = { version, manifest, digest };
  const startup = await probeOrFalse(() => options.probe.startup(staged));
  if (!startup.ok) {
    const error = `STAGED_STARTUP_FAILED: ${startup.detail}`;
    emit("fail", version, digest, error, configDigest);
    throw new Error(error);
  }
  const preflight = await probeOrFalse(() => options.probe.readiness(staged));
  if (!preflight.ok) {
    const error = `STAGED_READINESS_FAILED: ${preflight.detail}`;
    emit("fail", version, digest, error, configDigest);
    throw new Error(error);
  }
  emit("probe", version, digest, "启动与 readiness 预检通过", configDigest);

  // 原子提交：current 与 history 各经同目录 tmp → rename；history 失败时恢复旧指针。
  atomicWrite(store, pointerPath(root), JSON.stringify({ version, digest }));
  try {
    atomicWrite(store, historyPath(root), JSON.stringify([...previousHistory, version]));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      if (previousRaw === undefined) {
        if (store.remove === undefined) throw new Error("REMOVE_UNAVAILABLE");
        store.remove(pointerPath(root));
      } else {
        atomicWrite(store, pointerPath(root), previousRaw);
      }
    } catch (rollbackError) {
      const rollbackDetail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      const failure = `STAGED_HISTORY_WRITE_FAILED: ${detail}; POINTER_ROLLBACK_FAILED: ${rollbackDetail}`;
      emit("fail", version, digest, failure, configDigest);
      throw new Error(failure);
    }
    const failure = `STAGED_HISTORY_WRITE_FAILED: ${detail}`;
    emit("fail", version, digest, failure, configDigest);
    throw new Error(failure);
  }
  emit("switch", version, digest, `current 原子切换到 ${version}`, configDigest);

  const committed: Release = { version, manifest, digest };
  const after = await probeOrFalse(() => options.probe.readiness(committed));
  if (!after.ok) {
    if (previousRaw === undefined) {
      if (store.remove !== undefined) store.remove(pointerPath(root));
    } else {
      atomicWrite(store, pointerPath(root), previousRaw);
    }
    atomicWrite(store, historyPath(root), JSON.stringify(previousHistory));
    const error = `STAGED_POST_SWITCH_PROBE_MISMATCH: ${after.detail}`;
    emit("rollback", previous?.version ?? "none", digest, error, configDigest);
    return { from: previous?.version ?? null, to: version, digest, configDigest, rolledBack: true, error };
  }
  return { from: previous?.version ?? null, to: version, digest, configDigest, rolledBack: false };
}
