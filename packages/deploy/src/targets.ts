export type TargetId =
  | "linux-x64"
  | "linux-arm64"
  | "linux-x64-musl"
  | "linux-arm64-musl"
  | "linux-x64-baseline"
  | "linux-arm64-baseline"
  | "darwin-x64"
  | "darwin-arm64"
  | "darwin-x64-baseline"
  | "win32-x64"
  | "win32-arm64"
  | "win32-x64-baseline";

export const TARGETS: readonly TargetId[] = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "linux-x64-baseline",
  "linux-arm64-baseline",
  "darwin-x64",
  "darwin-arm64",
  "darwin-x64-baseline",
  "win32-x64",
  "win32-arm64",
  "win32-x64-baseline",
]);

export function validateTarget(target: string): boolean {
  return (TARGETS as readonly string[]).includes(target);
}

export function assertTarget(target: string): asserts target is TargetId {
  if (!validateTarget(target)) throw new Error(`INVALID_TARGET: ${target}`);
}

export function targetArch(target: string): "x64" | "arm64" {
  assertTarget(target);
  if (target.includes("arm64")) return "arm64";
  return "x64";
}

export interface BinaryImage {
  readonly arch: string;
  readonly embedded: readonly string[];
}

export function verifyBinaryArch(image: BinaryImage, target: TargetId): void {
  const expected = targetArch(target);
  if (image.arch !== expected) {
    throw new Error(`BINARY_ARCH_MISMATCH: expected ${expected}, got ${image.arch}`);
  }
  for (const arch of image.embedded) {
    if (arch !== expected) {
      throw new Error(`EMBEDDED_ARCH_MISMATCH: expected ${expected}, got ${arch}`);
    }
  }
}
