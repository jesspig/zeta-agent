import { verifyArtifactManifest, type ArtifactManifest } from "./artifact";
import { computeConfigDigest } from "./canonical";

export interface ReleaseStore {
  read(path: string): string;
  write(path: string, data: string): void;
  exists(path: string): boolean;
  remove?(path: string): void;
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
  store: ReleaseStore
): { from: string; to: string; digest: string } {
  const current = currentRelease(root, store);
  if (current.version === version) throw new Error(`VERSION_EXISTS: ${version}`);
  const installed = installRelease(root, version, manifest, store);
  return { from: current.version, to: installed.version, digest: installed.digest };
}

export function rollbackRelease(root: string, store: ReleaseStore): { from: string; to: string; digest: string } {
  const current = currentRelease(root, store);
  const history = readHistory(root, store);
  if (history.length < 2) throw new Error("HISTORY_EMPTY");
  const target = history[history.length - 2]!;
  const manifest = readJson<ArtifactManifest>(store, releasePath(root, target), target);
  verifyArtifactManifest(manifest);
  const digest = computeConfigDigest(manifest as unknown as Record<string, unknown>);
  writeState(root, store, target, digest, history.slice(0, -1));
  return { from: current.version, to: target, digest };
}
