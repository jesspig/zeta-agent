/**
 * 同目录临时文件 → 完整写入（处理短写）→ fsync → rename → 目录 fsync。
 * 失败或中断时目标文件仍是完整旧文件或完整新文件，绝不出现半写内容。
 */
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export type AtomicWriteStage =
  | "temp-opened"
  | "temp-writing"
  | "temp-synced"
  | "before-rename"
  | "renamed"
  | "dir-fsync"
  | "complete";

export interface AtomicWriteOptions {
  /** 故障注入：抛错即模拟 ENOSPC/中断；不抛错时记录顺序用于原子性验证。 */
  readonly hook?: (stage: AtomicWriteStage, path: string) => void;
  /** 强制单次 writeSync 的最大字节数，用于验证短写循环。 */
  readonly maxWriteChunk?: number;
}

function safeFlags(flags: number): number {
  return flags | fsConstants.O_NOFOLLOW;
}

export function atomicWriteFileSync(path: string, content: string, options: AtomicWriteOptions = {}): void {
  if (typeof path !== "string" || path.length === 0) throw new Error("INVALID_ATOMIC_WRITE_PATH");
  if (typeof content !== "string") throw new Error("INVALID_ATOMIC_WRITE_CONTENT");
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.zeta-tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const buffer = Buffer.from(content, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(tmp, safeFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL), 0o600);
    options.hook?.("temp-opened", tmp);
    let written = 0;
    const chunkSize = options.maxWriteChunk ?? buffer.length;
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("INVALID_WRITE_CHUNK");
    while (written < buffer.length) {
      const size = Math.min(chunkSize, buffer.length - written);
      const count = writeSync(fd, buffer, written, size);
      if (count <= 0) throw new Error("WRITE_STALL: short write made no progress");
      written += count;
      options.hook?.("temp-writing", tmp);
    }
    if (written !== buffer.length) throw new Error("WRITE_INCOMPLETE: short write did not finish");
    fsyncSync(fd);
    options.hook?.("temp-synced", tmp);
    closeSync(fd);
    fd = undefined;

    const stat = lstatSync(tmp);
    if (!stat.isFile() || stat.size !== buffer.length) throw new Error("WRITE_INCOMPLETE: temp file size mismatch");
    options.hook?.("before-rename", tmp);
    renameSync(tmp, path);
    options.hook?.("renamed", path);

    // Windows 目录句柄不支持 fsync；同目录 rename 本身已是原子提交点。
    options.hook?.("dir-fsync", dir);
    try {
      const dirFd = openSync(dir, safeFlags(fsConstants.O_RDONLY));
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // 平台不支持目录 fsync，忽略。
    }
    options.hook?.("complete", path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 已关闭，忽略。
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件可能已被 rename 消费或从未创建，忽略。
    }
    throw error;
  }
}
