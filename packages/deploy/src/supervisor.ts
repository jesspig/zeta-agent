import type { ArtifactManifest } from "./artifact";
import { start, type DeployConfig, type DeployHandle } from "./deployment";
import {
  currentRelease,
  installRelease,
  rollbackRelease,
  upgradeRelease,
  type Release,
  type ReleaseStore,
} from "./lifecycle";

export interface SupervisorEvent {
  readonly type: string;
  readonly generation: number;
  readonly version: string;
  readonly digest: string;
}

export interface SupervisorOptions {
  readonly root: string;
  readonly store: ReleaseStore;
  readonly config: DeployConfig;
  readonly startFactory?: (release: Release, config: DeployConfig, generation: number) => DeployHandle;
}

export interface Supervisor {
  readonly generation: number;
  readonly version: string;
  readonly digest: string;
  readonly active: DeployHandle | undefined;
  readonly events: readonly SupervisorEvent[];
  liveness(): boolean;
  install(version: string, manifest: ArtifactManifest): Release;
  upgrade(version: string, manifest: ArtifactManifest): { readonly from: string; readonly to: string; readonly digest: string };
  rollback(): { readonly from: string; readonly to: string; readonly digest: string };
  /** 进程内故障注入：停止当前 handle，保留 current 指针供后续恢复。 */
  fault(): void;
  recover(): Release;
  close(): void;
}

/**
 * 发布物 + 运行时 supervisor：升级/回滚先切换 current 指针再重启 handle，
 * 每次激活都提升代次；故障后只按当前指针启动一次，不重建身份或审批路径。
 */
export function createSupervisor(options: SupervisorOptions): Supervisor {
  const factory =
    options.startFactory ??
    ((_release: Release, config: DeployConfig): DeployHandle => start("daemon", config));
  const events: SupervisorEvent[] = [];
  let generation = 0;
  let active: DeployHandle | undefined;

  function record(type: string, release: Release): void {
    events.push({ type, generation, version: release.version, digest: release.digest });
  }

  function activate(release: Release, type: string): DeployHandle {
    active?.stop();
    active = undefined;
    generation += 1;
    try {
      active = factory(release, options.config, generation);
    } catch (error) {
      record("start.failed", release);
      throw error;
    }
    record(type, release);
    return active;
  }

  return {
    get generation() {
      return generation;
    },
    get version() {
      return currentRelease(options.root, options.store).version;
    },
    get digest() {
      return currentRelease(options.root, options.store).digest;
    },
    get active() {
      return active;
    },
    get events() {
      return [...events];
    },
    liveness() {
      return active !== undefined && active.liveness();
    },
    install(version, manifest) {
      const release = installRelease(options.root, version, manifest, options.store);
      activate(release, "install");
      return release;
    },
    upgrade(version, manifest) {
      const result = upgradeRelease(options.root, version, manifest, options.store);
      activate(currentRelease(options.root, options.store), "upgrade");
      return result;
    },
    rollback() {
      const result = rollbackRelease(options.root, options.store);
      activate(currentRelease(options.root, options.store), "rollback");
      return result;
    },
    fault() {
      if (active === undefined) return;
      active.stop();
      active = undefined;
      record("fault", currentRelease(options.root, options.store));
    },
    recover() {
      const release = currentRelease(options.root, options.store);
      activate(release, "recover");
      return release;
    },
    close() {
      if (active === undefined) return;
      active.stop();
      active = undefined;
      record("close", currentRelease(options.root, options.store));
    },
  };
}
