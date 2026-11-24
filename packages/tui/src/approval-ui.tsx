import {
  createApprovalBroker,
  type ApprovalChannel,
  type ApprovalReply,
  type ApprovalRequest,
  type ApprovalState,
} from "@zeta-agent/agent";
import { useKeyboard } from "@opentui/solid";
import { createSignal, Show, type Accessor } from "solid-js";

export type { ApprovalChannel, ApprovalRequest, ApprovalReply, ApprovalState };

/** TUI 侧审批通道：请求进入 UI，用户决定后以同一 requestId/replyId 回给 broker。 */
export interface ApprovalUiChannel {
  readonly channel: ApprovalChannel;
  readonly pending: Accessor<ApprovalRequest | undefined>;
  respond(state: ApprovalState): void;
}

export function createApprovalUiChannel(): ApprovalUiChannel {
  const [pending, setPending] = createSignal<ApprovalRequest | undefined>(undefined);
  let resolveReply: ((state: ApprovalState) => void) | undefined;
  let replySeq = 0;

  const channel: ApprovalChannel = {
    request(request, signal) {
      return new Promise<ApprovalReply>((resolve, reject) => {
        setPending(request);
        resolveReply = (state) => {
          resolveReply = undefined;
          setPending(undefined);
          resolve({
            requestId: request.requestId,
            replyId: `approval-reply-${++replySeq}`,
            state,
          });
        };
        signal?.addEventListener("abort", () => {
          if (resolveReply === undefined) return;
          resolveReply = undefined;
          setPending(undefined);
          reject(new Error("APPROVAL_CANCELLED"));
        }, { once: true });
      });
    },
  };

  return {
    channel,
    pending,
    respond(state) {
      resolveReply?.(state);
    },
  };
}

/** 与 headless/RPC 共用 createApprovalBroker 的装配入口，避免另建审批路径。 */
export function createSharedApproval(channel: ApprovalChannel) {
  return createApprovalBroker(channel);
}

/** 审批覆盖层：Y 允许一次、N 拒绝；键盘事件经 OpenTUI 安全解析。 */
export function ApprovalOverlay(props: { readonly channel: ApprovalUiChannel }) {
  useKeyboard((key) => {
    if (key.eventType === "release" || props.channel.pending() === undefined) return;
    if (key.name === "y") {
      key.preventDefault();
      key.stopPropagation();
      props.channel.respond("allowed-once");
      return;
    }
    if (key.name === "n") {
      key.preventDefault();
      key.stopPropagation();
      props.channel.respond("rejected");
    }
  });
  return (
    <Show when={props.channel.pending()}>
      {(request: () => ApprovalRequest) => (
        <box position="absolute" top={0} right={0} border={true} title="审批">
          <text>{`工具 ${request().tool}：${request().reason ?? "需要确认"}`}</text>
          <text>[Y] 允许一次  [N] 拒绝</text>
        </box>
      )}
    </Show>
  );
}
