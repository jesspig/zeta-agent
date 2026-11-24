import type { Agent } from "../facade";
import {
  createApprovalBroker,
  type ApprovalBroker,
  type ApprovalChannel,
} from "../plugins/permissions/approval";
import { createRuntimeProtocol, type RuntimeProtocol } from "./protocol";

/**
 * 四种 CLI 形态（TUI/headless/json/RPC）共享的装配入口。
 * control 走统一协议，approval 走同一 ApprovalChannel/broker；TUI 只替换通道实现为界面。
 */
export interface SharedControlPlane {
  readonly protocol: RuntimeProtocol;
  readonly approvalChannel: ApprovalChannel;
  readonly approval: ApprovalBroker;
}

export function createSharedControlPlane(
  agent: Agent,
  approvalChannel: ApprovalChannel,
): SharedControlPlane {
  return {
    protocol: createRuntimeProtocol(agent),
    approvalChannel,
    approval: createApprovalBroker(approvalChannel),
  };
}
