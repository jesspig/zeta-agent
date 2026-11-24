export interface StdoutWriterOptions {
  /** 协议输出的唯一出口；返回 false 表示底层流背压。 */
  readonly write: (chunk: string) => boolean;
  /** 诊断出口，永远与协议输出分离。缺省丢弃。 */
  readonly diagnostic?: (line: string) => void;
  readonly queueLimit?: number;
  /** 初始暂停：测试据此构造确定性背压窗口。 */
  readonly paused?: boolean;
}

export interface StdoutWriter {
  readonly queued: number;
  readonly dropped: number;
  readonly closed: boolean;
  /** 入队一行协议输出；队列满或已关闭返回 false，绝不抛穿到调用方。 */
  write(line: string): boolean;
  /** 诊断信息只写 stderr 通道，永远不进入 stdout 队列。 */
  diagnostic(line: string): void;
  pause(): void;
  resume(): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * stdout 专用 writer：协议输出单出口、有界队列背压、诊断独立 stderr、退出前 flush。
 * 底层 write 返回 false 时退避到下一轮事件循环再试，不丢行也不忙等。
 */
export function createStdoutWriter(options: StdoutWriterOptions): StdoutWriter {
  if (typeof options.write !== "function") throw new Error("STDOUT_WRITE_REQUIRED");
  const queueLimit = options.queueLimit ?? 256;
  if (!Number.isInteger(queueLimit) || queueLimit < 1) throw new Error("INVALID_STDOUT_QUEUE_LIMIT");
  const write = options.write;
  const diagnostic = options.diagnostic ?? (() => {});
  const queue: string[] = [];
  const waiters: Array<() => void> = [];
  let paused = options.paused === true;
  let closing = false;
  let closed = false;
  let pumped = false;
  let stalled = false;
  let drops = 0;

  function settle(): void {
    if (queue.length > 0 || stalled) return;
    const pending = waiters.splice(0);
    for (const resolve of pending) resolve();
  }

  function schedule(): void {
    if (pumped || closed) return;
    pumped = true;
    queueMicrotask(() => {
      pumped = false;
      pump();
    });
  }

  function pump(): void {
    if (closed || paused) return;
    while (!closed && !paused && queue.length > 0) {
      const line = queue.shift()!;
      let accepted = false;
      try {
        accepted = write(line) !== false;
      } catch (error) {
        diagnostic(`STDOUT_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
        accepted = true;
      }
      if (!accepted) {
        // Node 语义：write 返回 false 表示本次 chunk 已被接收但底层缓冲区已满，不能重放。
        stalled = true;
        setTimeout(() => {
          stalled = false;
          schedule();
        }, 0);
        return;
      }
    }
    settle();
  }

  return {
    get queued() {
      return queue.length;
    },
    get dropped() {
      return drops;
    },
    get closed() {
      return closed;
    },
    write(line) {
      if (closing || closed) {
        diagnostic("STDOUT_CLOSED: 拒绝新的协议输出");
        return false;
      }
      if (queue.length >= queueLimit) {
        drops += 1;
        diagnostic(`STDOUT_BACKPRESSURE: 队列已满 ${queueLimit}`);
        return false;
      }
      queue.push(line);
      schedule();
      return true;
    },
    diagnostic(line) {
      diagnostic(line);
    },
    pause() {
      paused = true;
    },
    resume() {
      if (!paused) return;
      paused = false;
      schedule();
    },
    flush() {
      if (queue.length === 0 && !stalled) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (!paused && !stalled) schedule();
      });
    },
    async close() {
      if (closed) return;
      closing = true;
      await this.flush();
      closed = true;
      settle();
    },
  };
}
