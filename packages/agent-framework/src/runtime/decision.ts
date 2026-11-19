import type { AgentEvent, AgentState } from "./agent";

export type AgentDecision =
  | { readonly kind: "reasoning"; readonly note: string }
  | { readonly kind: "acting"; readonly toolCallIds: readonly string[] }
  | { readonly kind: "exit"; readonly reason: string };

export const AGENT_DECISION_KINDS = ["reasoning", "acting", "exit"] as const satisfies readonly AgentDecision["kind"][];

export function nextAction(state: AgentState): AgentDecision {
  if (state.errorMessage !== undefined) return { kind: "exit", reason: state.errorMessage };
  if (state.pendingToolCalls.size > 0) {
    return { kind: "acting", toolCallIds: [...state.pendingToolCalls].sort() };
  }
  return { kind: "reasoning", note: `messages:${state.messages.length}` };
}

export function describeDecision(decision: AgentDecision): string {
  switch (decision.kind) {
    case "reasoning":
      return `reasoning:${decision.note}`;
    case "acting":
      return `acting:${decision.toolCallIds.join(",")}`;
    case "exit":
      return `exit:${decision.reason}`;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

export interface DecisionContext {
  readonly state: AgentState;
  readonly event: AgentEvent;
}

export type DecisionHook = (
  decision: AgentDecision,
  next: (value: AgentDecision) => void,
  context: DecisionContext
) => void | Promise<void>;

export interface DecisionWaterfall {
  add(hook: DecisionHook): () => void;
  run(initial: AgentDecision, context: DecisionContext): Promise<AgentDecision>;
  readonly size: number;
}

export function createDecisionWaterfall(): DecisionWaterfall {
  let hooks: DecisionHook[] = [];

  return {
    add(hook) {
      hooks.push(hook);
      return () => {
        hooks = hooks.filter((item) => item !== hook);
      };
    },
    async run(initial, context) {
      let current = initial;
      for (const hook of [...hooks]) {
        let advanced = false;
        await hook(
          current,
          (value) => {
            if (advanced) throw new Error("waterfall next() 重复调用");
            advanced = true;
            current = value;
          },
          context
        );
      }
      return current;
    },
    get size() {
      return hooks.length;
    },
  };
}
