import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertStartupArtifact,
  detectBinaryArch,
  type ArtifactManifest,
  verifyArtifactBytes,
  verifyArtifactManifest,
} from "./artifact";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function elf(arch: "x64" | "arm64"): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(18, arch === "x64" ? 0x3e : 0xb7, true);
  return bytes;
}

function pe(arch: "x64" | "arm64"): Uint8Array {
  const bytes = new Uint8Array(0x48);
  bytes.set([0x4d, 0x5a], 0);
  new DataView(bytes.buffer).setUint32(0x3c, 0x40, true);
  bytes.set([0x50, 0x45, 0x00, 0x00], 0x40);
  new DataView(bytes.buffer).setUint16(0x44, arch === "x64" ? 0x8664 : 0xaa64, true);
  return bytes;
}

function macho(arch: "x64" | "arm64"): Uint8Array {
  const bytes = new Uint8Array(8);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  new DataView(bytes.buffer).setUint32(4, arch === "x64" ? 0x01000007 : 0x0100000c, true);
  return bytes;
}

function manifest(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
  const native = elf("x64");
  const data = new TextEncoder().encode("catalog");
  return {
    version: 1,
    target: "linux-x64",
    binary: { arch: "x64", path: "zeta", bytes: native.byteLength, sha256: sha256(native) },
    embedded: [
      { id: "arch-marker", kind: "native", arch: "x64", path: "arch-marker.zetaasset", bytes: native.byteLength, sha256: sha256(native) },
      { id: "resource-catalog", kind: "data", arch: "universal", path: "resource-catalog.zetaasset", bytes: data.byteLength, sha256: sha256(data) },
    ],
    ...overrides,
  };
}

describe("T-20 单文件产物架构校验", () => {
  test("detectBinaryArch 识别 ELF / PE / Mach-O 的 x64 与 arm64", () => {
    expect(detectBinaryArch(elf("x64"))).toBe("x64");
    expect(detectBinaryArch(elf("arm64"))).toBe("arm64");
    expect(detectBinaryArch(pe("x64"))).toBe("x64");
    expect(detectBinaryArch(pe("arm64"))).toBe("arm64");
    expect(detectBinaryArch(macho("x64"))).toBe("x64");
    expect(detectBinaryArch(macho("arm64"))).toBe("arm64");
    expect(detectBinaryArch(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  test("verifyArtifactManifest 接受匹配产物，拒绝主二进制/嵌入资源架构错配", () => {
    expect(() => verifyArtifactManifest(manifest())).not.toThrow();
    expect(() => verifyArtifactManifest(manifest({ target: "linux-arm64" }))).toThrow(/BINARY_ARCH_MISMATCH/);
    const base = manifest();
    const wrongEmbedded = manifest({
      embedded: [{ ...base.embedded[0]!, arch: "arm64" }, base.embedded[1]!],
    });
    expect(() => verifyArtifactManifest(wrongEmbedded)).toThrow(/EMBEDDED_ARCH_MISMATCH/);
  });

  test("verifyArtifactManifest 拒绝重复 id 与非 SHA-256 摘要", () => {
    const base = manifest();
    const duplicate = manifest({ embedded: [base.embedded[0]!, { ...base.embedded[0]!, path: "copy.zetaasset" }] });
    expect(() => verifyArtifactManifest(duplicate)).toThrow(/DUPLICATE|duplicate/i);
    const badHash = manifest({ binary: { ...base.binary, sha256: "deadbeef" } });
    expect(() => verifyArtifactManifest(badHash)).toThrow(/SHA256|sha256/i);
  });

  test("verifyArtifactBytes 校验实际字节的摘要与架构", () => {
    const good = elf("x64");
    const catalog = new TextEncoder().encode("catalog");
    const bytes = { binary: good, "arch-marker": good, "resource-catalog": catalog };
    expect(() => verifyArtifactBytes(manifest(), bytes)).not.toThrow();
    const arm64 = elf("arm64");
    const base = manifest();
    const wrongArch = manifest({
      embedded: [
        { ...base.embedded[0]!, bytes: arm64.byteLength, sha256: sha256(arm64) },
        base.embedded[1]!,
      ],
    });
    expect(() => verifyArtifactBytes(wrongArch, { ...bytes, "arch-marker": arm64 })).toThrow(/EMBEDDED_ARCH_MISMATCH/);
    const tampered = new Uint8Array(good);
    tampered[10] = 0x99;
    expect(() => verifyArtifactBytes(manifest(), { ...bytes, "arch-marker": tampered })).toThrow(/SHA256|sha256/i);
  });

  test("verifyArtifactBytes 要求完整嵌入 bytes，拒绝缺失、字节数不符与未声明 marker", () => {
    const good = elf("x64");
    const catalog = new TextEncoder().encode("catalog");
    const base = manifest();
    const complete = { binary: good, "arch-marker": good, "resource-catalog": catalog };
    expect(() => verifyArtifactBytes(base, { binary: good, "arch-marker": good })).toThrow(/EMBEDDED_BYTES_MISSING/);
    expect(() => verifyArtifactBytes(base, { ...complete, "resource-catalog": new Uint8Array([1]) })).toThrow(
      /EMBEDDED_BYTES_LENGTH_MISMATCH|SHA256/i
    );
    expect(() => verifyArtifactBytes(base, { ...complete, "synthetic-marker": good })).toThrow(
      /UNDECLARED_EMBEDDED_BYTES/
    );
    expect(() => verifyArtifactBytes(base, complete, { requireBinary: true })).not.toThrow();
    expect(() => verifyArtifactBytes(base, { "arch-marker": good, "resource-catalog": catalog }, { requireBinary: true })).toThrow(
      /BINARY_BYTES_MISSING/
    );
  });

  test("assertStartupArtifact 在架构错配时拒绝启动，匹配时放行", () => {
    const runtime = elf("x64");
    const data = new TextEncoder().encode("catalog");
    const assets = { "arch-marker": "/fake/arch-marker.zetaasset", "resource-catalog": "/fake/resource-catalog.zetaasset" };
    const readFile = (path: string): Uint8Array =>
      path.endsWith(".zetaasset") ? (path.includes("arch-marker") ? runtime : data) : runtime;
    expect(() =>
      assertStartupArtifact(manifest(), assets, {
        compiled: true,
        executablePath: "/fake/zeta",
        readFile,
      })
    ).not.toThrow();
    const arm64 = elf("arm64");
    const base = manifest();
    const wrongEmbedded = manifest({
      embedded: [
        { ...base.embedded[0]!, bytes: arm64.byteLength, sha256: sha256(arm64) },
        base.embedded[1]!,
      ],
    });
    expect(() =>
      assertStartupArtifact(wrongEmbedded, assets, {
        compiled: true,
        executablePath: "/fake/zeta",
        readFile: (path) => (path.includes("arch-marker") ? arm64 : runtime),
      })
    ).toThrow(/EMBEDDED_ARCH_MISMATCH/);
    expect(() =>
      assertStartupArtifact(manifest(), assets, {
        compiled: true,
        executablePath: "/fake/zeta",
        readFile: (path) => (path === "/fake/zeta" ? elf("arm64") : path.includes("arch-marker") ? runtime : data),
      })
    ).toThrow(/BINARY_ARCH_MISMATCH/);
  });

  test("嵌入 manifest 自指哈希可省略，架构校验仍生效", () => {
    const runtime = elf("x64");
    const data = new TextEncoder().encode("catalog");
    const unsigned = manifest({ binary: { ...manifest().binary, sha256: undefined } });
    const assets = { "arch-marker": "/fake/arch-marker.zetaasset", "resource-catalog": "/fake/resource-catalog.zetaasset" };
    expect(() =>
      assertStartupArtifact(unsigned, assets, {
        compiled: true,
        executablePath: "/fake/zeta",
        readFile: (path) => (path.endsWith(".zetaasset") ? (path.includes("arch-marker") ? runtime : data) : runtime),
      })
    ).not.toThrow();
  });

  test("源码模式不对 bun 自身做架构断言", () => {
    const runtime = elf("x64");
    const data = new TextEncoder().encode("catalog");
    const assets = { "arch-marker": "/fake/arch-marker.zetaasset", "resource-catalog": "/fake/resource-catalog.zetaasset" };
    expect(() =>
      assertStartupArtifact(manifest(), assets, {
        compiled: false,
        readFile: (path) => (path.includes("arch-marker") ? runtime : data),
      })
    ).not.toThrow();
  });
});
