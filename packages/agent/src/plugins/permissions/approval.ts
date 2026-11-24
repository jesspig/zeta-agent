/** 四态审批：只允许 allowed-once 放行；其余状态一律 fail-closed。 */
export type ApprovalState = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export const APPROVAL_STATES = ["allowed-once", "rejected", "cancelled", "unavailable"] as const satisfies readonly ApprovalState[];

export interface ApprovalRequest {
  /** 每次请求唯一；broker 保证同一 ID 只消费一次，杜绝 reply 重放。 */
  readonly requestId: string;
  readonly stage: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly timeoutMs?: number;
}

export interface ApprovalReply {
  readonly requestId: string;
  readonly replyId: string;
  readonly state: ApprovalState;
  readonly reason?: string;
}

export interface ApprovalChannel {
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalReply>;
}

export interface ApprovalDecision {
  readonly state: ApprovalState;
  readonly allowed: boolean;
  readonly requestId: string;
  readonly replyId?: string;
  readonly reason?: string;
}

export interface ApprovalBroker {
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  readonly consumed: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 5000;

function isApprovalState(value: unknown): value is ApprovalState {
  return APPROVAL_STATES.includes(value as ApprovalState);
}

/** 无通道、超时、ID 不匹配与通道异常都归为 unavailable；abort 归为 cancelled。 */
export function createApprovalBroker(channel: ApprovalChannel | undefined): ApprovalBroker {
  const used = new Set<string>();
  return {
    async request(request, signal) {
      const unavailable = (reason: string): ApprovalDecision => ({
        state: "unavailable",
        allowed: false,
        requestId: request.requestId,
        reason,
      });
      if (channel === undefined) return unavailable("APPROVAL_CHANNEL_UNAVAILABLE");
      if (used.has(request.requestId)) return unavailable("APPROVAL_REQUEST_REPLAY");
      if (signal?.aborted === true) {
        return { state: "cancelled", allowed: false, requestId: request.requestId };
      }
      used.add(request.requestId);

      const outcome = await new Promise<ApprovalReply | ApprovalState>((resolve) => {
        let settled = false;
        const finish = (value: ApprovalReply | ApprovalState): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal !== undefined) signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const onAbort = (): void => finish("cancelled");
        const timer = setTimeout(() => finish("unavailable"), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
        void channel.request(request, signal).then(
          (reply) => finish(reply),
          () => finish("unavailable")
        );
      });

      if (typeof outcome === "string") {
        return { state: outcome, allowed: false, requestId: request.requestId };
      }
      if (outcome.requestId !== request.requestId || outcome.replyId.length === 0 || !isApprovalState(outcome.state)) {
        return unavailable("APPROVAL_REPLY_INVALID");
      }
      return {
        state: outcome.state,
        allowed: outcome.state === "allowed-once",
        requestId: request.requestId,
        replyId: outcome.replyId,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      };
    },
    get consumed() {
      return [...used];
    },
  };
}
