import type { Disposer } from "../types";

export interface Link {
  readonly closed: boolean;
  /** 关闭后 send 为 no-op。 */
  send(message: unknown): void;
  /** 单 listener：重复注册抛错。 */
  onMessage(listener: (message: unknown) => void): Disposer;
  onClose(listener: () => void): Disposer;
  close(): void;
}

interface Endpoint {
  enqueue(message: unknown): void;
}

function createLink(forward: (message: unknown) => void): { link: Link; endpoint: Endpoint } {
  const queue: unknown[] = [];
  const closeListeners = new Set<() => void>();
  let closed = false;
  let listener: ((message: unknown) => void) | undefined;
  let draining = false;

  function drain(): void {
    if (draining) return;
    draining = true;
    queueMicrotask(() => {
      try {
        while (!closed && queue.length > 0) {
          const message = queue.shift() as unknown;
          listener?.(message);
        }
      } finally {
        draining = false;
      }
    });
  }

  const endpoint: Endpoint = {
    enqueue(message: unknown): void {
      if (closed) return;
      queue.push(message);
      drain();
    },
  };

  const link: Link = {
    get closed(): boolean {
      return closed;
    },
    send(message: unknown): void {
      if (closed) return;
      forward(message);
    },
    onMessage(next: (message: unknown) => void): Disposer {
      if (closed) throw new Error("LINK_CLOSED");
      if (listener !== undefined) throw new Error("SINGLE_LISTENER");
      listener = next;
      return (): void => {
        if (listener === next) listener = undefined;
      };
    },
    onClose(next: () => void): Disposer {
      if (closed) {
        next();
        return (): void => {};
      }
      closeListeners.add(next);
      return (): void => {
        closeListeners.delete(next);
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      queue.length = 0;
      listener = undefined;
      for (const next of [...closeListeners]) next();
      closeListeners.clear();
    },
  };

  return { link, endpoint };
}

/** 进程内成对 Link：A.send 投递到 B.onMessage，反之亦然。 */
export function memoryLinkPair(): readonly [Link, Link] {
  let peerA: Endpoint | undefined;
  let peerB: Endpoint | undefined;
  const a = createLink((message) => peerB?.enqueue(message));
  const b = createLink((message) => peerA?.enqueue(message));
  peerA = a.endpoint;
  peerB = b.endpoint;
  return Object.freeze([a.link, b.link] as const);
}
