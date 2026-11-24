import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { basename } from "node:path";
import { assertTarget, targetArch, type TargetId } from "./targets";

export type NativeArch = "x64" | "arm64";

export interface EmbeddedResource {
  readonly id: string;
  readonly kind: "native" | "data";
  readonly arch: NativeArch | "universal";
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ArtifactManifest {
  readonly version: 1;
  readonly target: TargetId;
  readonly binary: {
    readonly arch: NativeArch;
    readonly path: string;
    readonly bytes: number;
    /** 仅发布产物填写；源码模式的默认 manifest 不含自身哈希。 */
    readonly sha256?: string;
  };
  readonly embedded: readonly EmbeddedResource[];
}

export interface StartupArtifactDeps {
  readonly compiled?: boolean;
  readonly executablePath?: string;
  readonly readFile?: (path: string) => Uint8Array;
  readonly readHeader?: (path: string) => Uint8Array;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 从 ELF / PE / Mach-O 文件头读取机器架构；非可执行格式返回 undefined。 */
export function detectBinaryArch(bytes: Uint8Array): NativeArch | undefined {
  if (bytes.length < 8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    const machine = view.getUint16(18, true);
    if (machine === 0x3e) return "x64";
    if (machine === 0xb7) return "arm64";
    return undefined;
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x5a && bytes.length >= 0x48) {
    const offset = view.getUint32(0x3c, true);
    if (offset + 6 > bytes.length) return undefined;
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x45) return undefined;
    const machine = view.getUint16(offset + 4, true);
    if (machine === 0x8664) return "x64";
    if (machine === 0xaa64) return "arm64";
    return undefined;
  }
  if (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) {
    const cpuType = view.getUint32(4, true);
    if (cpuType === 0x01000007) return "x64";
    if (cpuType === 0x0100000c) return "arm64";
  }
  return undefined;
}

function requireSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`ARTIFACT_SHA256_INVALID: ${label} = ${value}`);
}

export function verifyArtifactManifest(manifest: ArtifactManifest): void {
  if (manifest.version !== 1) throw new Error(`ARTIFACT_VERSION_UNSUPPORTED: ${manifest.version}`);
  assertTarget(manifest.target);
  const expected = targetArch(manifest.target);
  if (manifest.binary.arch !== expected) {
    throw new Error(`BINARY_ARCH_MISMATCH: expected ${expected}, got ${manifest.binary.arch}`);
  }
  if (manifest.binary.sha256 !== undefined) requireSha256(manifest.binary.sha256, "binary");
  if (manifest.binary.bytes < 0) throw new Error("ARTIFACT_BYTES_INVALID: binary");

  const ids = new Set<string>();
  for (const resource of manifest.embedded) {
    if (ids.has(resource.id)) throw new Error(`DUPLICATE_EMBEDDED_ID: ${resource.id}`);
    ids.add(resource.id);
    requireSha256(resource.sha256, resource.id);
    if (resource.bytes < 0) throw new Error(`ARTIFACT_BYTES_INVALID: ${resource.id}`);
    if (resource.kind === "native") {
      if (resource.arch !== expected) {
        throw new Error(`EMBEDDED_ARCH_MISMATCH: ${resource.id} expected ${expected}, got ${resource.arch}`);
      }
    } else if (resource.arch !== "universal") {
      throw new Error(`EMBEDDED_ARCH_MISMATCH: ${resource.id} data resource must be universal`);
    }
  }
}

export function verifyArtifactBytes(
  manifest: ArtifactManifest,
  bytes: Readonly<Record<string, Uint8Array>>
): void {
  const binary = bytes.binary;
  if (binary !== undefined) {
    if (manifest.binary.sha256 === undefined) throw new Error("ARTIFACT_SHA256_MISSING: binary");
    if (sha256Hex(binary) !== manifest.binary.sha256) throw new Error("ARTIFACT_SHA256_MISMATCH: binary");
    const detected = detectBinaryArch(binary);
    if (detected !== undefined && detected !== manifest.binary.arch) {
      throw new Error(`BINARY_ARCH_MISMATCH: expected ${manifest.binary.arch}, got ${detected}`);
    }
  }
  for (const resource of manifest.embedded) {
    const content = bytes[resource.id];
    if (content === undefined) continue;
    if (sha256Hex(content) !== resource.sha256) throw new Error(`ARTIFACT_SHA256_MISMATCH: ${resource.id}`);
    if (resource.kind === "native") {
      const detected = detectBinaryArch(content);
      if (detected === undefined || detected !== resource.arch) {
        throw new Error(`EMBEDDED_ARCH_MISMATCH: ${resource.id} expected ${resource.arch}, got ${detected}`);
      }
    }
  }
}

function readHeader(path: string, length = 128): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buffer = new Uint8Array(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export function isCompiledExecutable(executablePath = process.execPath): boolean {
  return !/^bun(?:\.exe)?$/i.test(basename(executablePath));
}

/** 启动前的产物门禁：架构错配或资源损坏直接抛错，调用方不得降级放行。 */
export function assertStartupArtifact(
  manifest: ArtifactManifest,
  assets: Readonly<Record<string, string>>,
  deps: StartupArtifactDeps = {}
): void {
  verifyArtifactManifest(manifest);
  const compiled = deps.compiled ?? isCompiledExecutable();
  const readFile = deps.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)));

  if (compiled) {
    const executablePath = deps.executablePath ?? process.execPath;
    const headerReader =
      deps.readHeader ??
      (deps.readFile !== undefined
        ? (path: string) => deps.readFile!(path)
        : (path: string) => readHeader(path));
    const executable =
      manifest.binary.sha256 === undefined ? headerReader(executablePath) : readFile(executablePath);
    const detected = detectBinaryArch(executable);
    if (detected === undefined || detected !== manifest.binary.arch) {
      throw new Error(`BINARY_ARCH_MISMATCH: expected ${manifest.binary.arch}, got ${detected}`);
    }
    // 嵌入 manifest 不能包含自身哈希（自指）；发布目录的 manifest.json 才记录它。
    if (manifest.binary.sha256 !== undefined && sha256Hex(executable) !== manifest.binary.sha256) {
      throw new Error("ARTIFACT_SHA256_MISMATCH: binary");
    }
  }

  for (const resource of manifest.embedded) {
    const path = assets[resource.id];
    if (path === undefined) throw new Error(`MISSING_EMBEDDED_ASSET: ${resource.id}`);
    const content = readFile(path);
    if (content.byteLength !== resource.bytes || sha256Hex(content) !== resource.sha256) {
      throw new Error(`ARTIFACT_SHA256_MISMATCH: ${resource.id}`);
    }
    if (compiled && resource.kind === "native") {
      const detected = detectBinaryArch(content);
      if (detected === undefined || detected !== resource.arch) {
        throw new Error(`EMBEDDED_ARCH_MISMATCH: ${resource.id} expected ${resource.arch}, got ${detected}`);
      }
    }
  }
}
