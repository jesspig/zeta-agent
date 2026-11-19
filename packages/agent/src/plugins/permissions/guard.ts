import type { Disposer } from "@zeta-agent/framework";
import {
  createPermissionGuard,
  type PermissionBehavior,
  type PermissionVerdict,
} from "@zeta-agent/agent-framework";

export interface StageToolDeclaration {
  readonly tool: string;
  readonly stages: readonly string[];
}

export interface BeforeToolCallContext {
  readonly stage: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface GateDecision {
  readonly behavior: PermissionBehavior;
  readonly reason?: string;
}

export type BeforeToolCallHook = (
  context: BeforeToolCallContext,
  next: (decision: GateDecision) => void
) => void | Promise<void>;

export interface PermissionGate {
  declareTools(declarations: readonly StageToolDeclaration[]): Disposer;
  addBeforeToolCall(hook: BeforeToolCallHook): Disposer;
  authorize(
    stage: string,
    tool: string,
    input?: Readonly<Record<string, unknown>>
  ): Promise<GateDecision>;
  toolsForStage(stage: string): readonly string[];
  readonly hookCount: number;
}

export function createPermissionGate(): PermissionGate {
  const declarations: StageToolDeclaration[] = [];
  const hooks: BeforeToolCallHook[] = [];
  const guard = createPermissionGuard();

  return {
    declareTools(items) {
      declarations.push(...items);
      return () => {
        for (const item of items) {
          const index = declarations.indexOf(item);
          if (index >= 0) declarations.splice(index, 1);
        }
      };
    },
    addBeforeToolCall(hook) {
      hooks.push(hook);
      return () => {
        const index = hooks.indexOf(hook);
        if (index >= 0) hooks.splice(index, 1);
      };
    },
    async authorize(stage, tool, input = {}) {
      const declared = declarations.some(
        (item) => item.tool === tool && item.stages.includes(stage)
      );
      const buildTime: PermissionVerdict = declared
        ? { behavior: "ALLOW" }
        : { behavior: "DENY", reason: `STAGE_TOOL_UNDECLARED: ${tool}@${stage}` };

      const runtimeDecisions: GateDecision[] = [];
      const context: BeforeToolCallContext = { stage, tool, input };
      for (const hook of [...hooks]) {
        let advanced = false;
        await hook(context, (decision) => {
          if (advanced) throw new Error("BEFORE_TOOL_CALL_NEXT_TWICE");
          advanced = true;
          runtimeDecisions.push(decision);
        });
      }

      const verdicts: PermissionVerdict[] = [
        buildTime,
        ...runtimeDecisions.map((decision) => ({ behavior: decision.behavior, reason: decision.reason })),
      ];
      const final = guard.evaluate(verdicts);
      return { behavior: final.behavior, reason: final.reason };
    },
    toolsForStage(stage) {
      const names = new Set<string>();
      for (const item of declarations) {
        if (item.stages.includes(stage)) names.add(item.tool);
      }
      return [...names].sort();
    },
    get hookCount() {
      return hooks.length;
    },
  };
}
