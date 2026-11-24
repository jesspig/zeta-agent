import {
  CRITICAL_LAYERS,
  operationState,
  type Capabilities,
  type CapabilityKey,
  type OperationCapabilityReport,
  type OperationName,
} from "@zeta-agent/security";
import type { AssemblyProfile } from "./builtins";
import type { CapabilityDiagnostic, CapabilityState } from "./manifest";

/** builtin 工具到结构化后端操作的映射：provider 可见性完全由最终能力报告决定。 */
const TOOL_OPERATION: Readonly<Record<string, OperationName>> = Object.freeze({
  read: "file.read",
  ls: "file.list",
  grep: "file.list",
  find: "file.list",
  write: "file.write",
  edit: "file.applyPatch",
  bash: "shell.start",
  powershell: "shell.start",
});

export function operationForTool(name: string): OperationName | undefined {
  return TOOL_OPERATION[name];
}

function describe(state: CapabilityState, subject: string, profile: AssemblyProfile): string {
  if (state === "active") return `${subject} 在 ${profile} 下真实可用`;
  if (state === "disabled") return `${subject} 在 ${profile} 下被明确禁用`;
  if (state === "degraded") return `${subject} 降级，失败关闭，不得宣称 active`;
  return `${subject} 未接入真实后端，unsupported（不伪装 active）`;
}

/**
 * 由当前 backend 的真实能力报告生成诊断。profile 只控制暴露范围，
 * 不修改能力状态：shell 等未实现能力在 local-full 下仍如实标记 unsupported。
 */
export function diagnoseCapabilities(
  profile: AssemblyProfile,
  capabilities: Capabilities,
  operations: OperationCapabilityReport
): CapabilityDiagnostic[] {
  const diagnostics: CapabilityDiagnostic[] = [];

  for (const layer of CRITICAL_LAYERS) {
    const state = capabilities[layer as CapabilityKey] as CapabilityState;
    diagnostics.push({
      id: `capability:${layer}`,
      state,
      reason: describe(state, `capability.${layer}`, profile),
    });
  }

  for (const operation of Object.keys(operations.operations) as OperationName[]) {
    const state = operationState(operations, operation) as CapabilityState;
    diagnostics.push({
      id: `operation:${operation}`,
      state,
      reason: describe(state, `operation.${operation}`, profile),
    });
  }

  for (const [tool, operation] of Object.entries(TOOL_OPERATION)) {
    const state = operationState(operations, operation) as CapabilityState;
    diagnostics.push({
      id: `tool:${tool}`,
      state,
      reason: `${describe(state, `operation.${operation}`, profile)} → tool.${tool}`,
    });
  }

  return diagnostics;
}

/**
 * 最终 active registry：只有能力诊断明确为 active 的 builtin 才进入 provider schema。
 * 未登记诊断的插件工具（如显式注入的 MCP 工具）默认可执行——宿主已显式接管其生命周期。
 */
export function executableToolNames(
  toolNames: readonly string[],
  diagnostics: readonly CapabilityDiagnostic[]
): readonly string[] {
  const states = new Map(
    diagnostics
      .filter((item) => item.id.startsWith("tool:"))
      .map((item) => [item.id.slice("tool:".length), item.state])
  );
  return toolNames.filter((name) => {
    const state = states.get(name);
    return state === undefined || state === "active";
  });
}
