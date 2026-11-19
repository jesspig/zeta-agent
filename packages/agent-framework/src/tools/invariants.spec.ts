import { describe, expect, test } from "bun:test";
import {
  createPermissionGuard,
  createTerminationController,
  createToolRegistry,
  validateInput,
  type PermissionBehavior,
  type PermissionVerdict,
  type TerminationController,
  type ToolDescriptor,
  type ToolExecuteContext,
  type ToolResult,
  type ToolUpdate,
} from "./pipeline";
import { executeConditionalBatch, type ConditionalCall } from "./parallel";

interface RunOptions {
  readonly verdicts?: readonly PermissionVerdict[];
  readonly bypass?: boolean;
  readonly clock?: () => number;
  readonly onUpdate?: (update: ToolUpdate) => void;
  readonly controller?: TerminationController;
}

interface InvariantScope {
  readonly size: number;
  register(tool: ToolDescriptor): () => void;
  run(batch: readonly ConditionalCall[], options?: RunOptions): Promise<readonly ToolResult[]>;
}

interface InvariantAdapter {
  readonly kind: "legacy" | "plugin";
  createScope(): InvariantScope;
  evaluate(verdicts: readonly PermissionVerdict[], bypass?: boolean): PermissionVerdict;
  validate(tool: ToolDescriptor, input: unknown): void;
}

interface Invariant {
  readonly id: number;
  readonly name: string;
  readonly check: (adapter: InvariantAdapter) => void | Promise<void>;
}

const RANK: Readonly<Record<PermissionBehavior, number>> = {
  PASSTHROUGH: 0,
  ALLOW: 1,
  ASK: 2,
  DENY: 3,
};

function legacyEvaluate(verdicts: readonly PermissionVerdict[], bypass = false): PermissionVerdict {
  let winner: PermissionVerdict = { behavior: "PASSTHROUGH" };
  for (const verdict of verdicts) {
    if (bypass && verdict.bypassImmune !== true && (verdict.behavior === "DENY" || verdict.behavior === "ASK")) {
      continue;
    }
    if (RANK[verdict.behavior] > RANK[winner.behavior]) winner = verdict;
  }
  return winner;
}

function legacyValidate(tool: ToolDescriptor, input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("TOOL_INPUT_NOT_OBJECT");
  }
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (!tool.inputSchema.includes(key)) throw new Error(`TOOL_INPUT_EXTRA_FIELD: ${key}`);
  }
}

function legacyError(call: ConditionalCall, reason: string, durationMs: number): ToolResult {
  return {
    callId: call.id,
    tool: call.tool,
    output: { error: reason },
    isError: true,
    durationMs: Math.max(0, durationMs),
    reason,
  };
}

function levelsOf(batch: readonly ConditionalCall[]): ConditionalCall[][] {
  const remaining = new Map(batch.map((call) => [call.id, call]));
  const levels: ConditionalCall[][] = [];
  while (remaining.size > 0) {
    const level: ConditionalCall[] = [];
    for (const call of remaining.values()) {
      if ((call.dependsOn ?? []).every((dep) => !remaining.has(dep))) level.push(call);
    }
    if (level.length === 0) level.push(...remaining.values());
    for (const call of level) remaining.delete(call.id);
    levels.push(level);
  }
  return levels;
}

async function legacyRunCall(
  call: ConditionalCall,
  tool: ToolDescriptor,
  options: RunOptions,
  clock: () => number
): Promise<ToolResult> {
  if (options.controller?.terminated === true) return legacyError(call, "BATCH_TERMINATED", 0);
  const verdict = legacyEvaluate(options.verdicts ?? [], options.bypass ?? false);
  if (verdict.behavior === "DENY") return legacyError(call, "TOOL_PERMISSION_DENIED", 0);
  if (verdict.behavior === "ASK") return legacyError(call, "TOOL_PERMISSION_ASK", 0);
  try {
    legacyValidate(tool, call.input);
  } catch (error) {
    return legacyError(call, (error as Error).message, 0);
  }

  let settled = false;
  const pending: Promise<unknown>[] = [];
  const exec: ToolExecuteContext = {
    onUpdate(partialResult) {
      if (settled) return;
      const returned = options.onUpdate?.({
        callId: call.id,
        tool: call.tool,
        phase: "update",
        partialResult,
        terminate: (reason) => options.controller?.terminate(reason),
      });
      if (returned !== undefined && typeof (returned as PromiseLike<unknown>).then === "function") {
        pending.push(Promise.resolve(returned));
      }
    },
    terminate: (reason) => options.controller?.terminate(reason),
    terminated: () => options.controller?.terminated === true,
    signal: options.controller?.signal,
  };

  const startedAt = clock();
  let output: unknown;
  try {
    output = await tool.execute(call.input, exec);
  } catch (error) {
    settled = true;
    await Promise.allSettled(pending);
    return legacyError(call, `TOOL_EXECUTION_ERROR: ${(error as Error).message}`, clock() - startedAt);
  }
  settled = true;
  await Promise.allSettled(pending);
  const durationMs = Math.max(0, clock() - startedAt);
  if (output === undefined || output === null) return legacyError(call, "TOOL_OUTPUT_MISSING", durationMs);
  if (typeof output === "object") {
    const extra = Object.keys(output as Record<string, unknown>).find((key) => !tool.outputSchema.includes(key));
    if (extra !== undefined) return legacyError(call, "TOOL_OUTPUT_EXTRA_FIELD", durationMs);
  }
  return { callId: call.id, tool: call.tool, output, isError: false, durationMs };
}

function createLegacyScope(): InvariantScope {
  const tools = new Map<string, ToolDescriptor>();
  return {
    get size() {
      return tools.size;
    },
    register(tool) {
      if (tools.has(tool.name)) throw new Error("TOOL_DUPLICATE");
      tools.set(tool.name, tool);
      return () => {
        tools.delete(tool.name);
      };
    },
    async run(batch, options = {}) {
      const clock = options.clock ?? (() => performance.now());
      const results = new Map<string, ToolResult>();
      for (const level of levelsOf(batch)) {
        await Promise.allSettled(
          level.map(async (call) => {
            const tool = tools.get(call.tool);
            if (tool === undefined) {
              results.set(call.id, legacyError(call, "TOOL_NOT_FOUND", 0));
              return;
            }
            const unmet = (call.dependsOn ?? []).some(
              (dep) => !results.has(dep) || results.get(dep)?.isError === true
            );
            if (options.controller?.terminated === true) {
              results.set(call.id, legacyError(call, "BATCH_TERMINATED", 0));
              return;
            }
            if (unmet) {
              results.set(call.id, legacyError(call, "TOOL_DEPENDENCY_UNSATISFIED", 0));
              return;
            }
            results.set(call.id, await legacyRunCall(call, tool, options, clock));
          })
        );
      }
      return batch.map((call) => results.get(call.id) as ToolResult);
    },
  };
}

function createPluginScope(): InvariantScope {
  const registry = createToolRegistry();
  return {
    get size() {
      return registry.size;
    },
    register: (tool) => registry.registerTool(tool),
    run: (batch, options = {}) => executeConditionalBatch(batch, { registry, ...options }),
  };
}

const ADAPTERS: readonly InvariantAdapter[] = [
  {
    kind: "legacy",
    createScope: createLegacyScope,
    evaluate: legacyEvaluate,
    validate: legacyValidate,
  },
  {
    kind: "plugin",
    createScope: createPluginScope,
    evaluate: (verdicts, bypass) => createPermissionGuard().evaluate(verdicts, { bypass }),
    validate: validateInput,
  },
];

function descriptor(name: string, execute: ToolDescriptor["execute"]): ToolDescriptor {
  return { name, inputSchema: [], outputSchema: ["ok"], execute };
}

const INVARIANTS: readonly Invariant[] = [
  {
    id: 1,
    name: "reverse-call-once",
    async check(adapter) {
      const scope = adapter.createScope();
      const counts = { a: 0, b: 0 };
      scope.register(descriptor("a", () => (counts.a += 1, { ok: "a" })));
      scope.register(descriptor("b", () => (counts.b += 1, { ok: "b" })));
      const results = await scope.run([
        { id: "z", tool: "b", input: {} },
        { id: "y", tool: "a", input: {} },
      ]);
      expect(counts).toEqual({ a: 1, b: 1 });
      expect(results.map((result) => result.callId)).toEqual(["z", "y"]);
    },
  },
  {
    id: 2,
    name: "no-residue",
    async check(adapter) {
      const scope = adapter.createScope();
      const dispose = scope.register(descriptor("a", () => ({ ok: true })));
      expect(scope.size).toBe(1);
      dispose();
      expect(scope.size).toBe(0);
      const [result] = await scope.run([{ id: "1", tool: "a", input: {} }]);
      expect(result?.reason).toContain("TOOL_NOT_FOUND");
    },
  },
  {
    id: 3,
    name: "guard-monotonic",
    check(adapter) {
      expect(adapter.evaluate([{ behavior: "DENY" }, { behavior: "ALLOW" }]).behavior).toBe("DENY");
      expect(adapter.evaluate([{ behavior: "ALLOW" }, { behavior: "DENY" }]).behavior).toBe("DENY");
    },
  },
  {
    id: 4,
    name: "output-forced",
    async check(adapter) {
      const scope = adapter.createScope();
      scope.register(descriptor("a", () => undefined));
      const [result] = await scope.run([{ id: "1", tool: "a", input: {} }]);
      expect(result?.isError).toBe(true);
      expect(result?.reason).toContain("TOOL_OUTPUT_MISSING");
    },
  },
  {
    id: 5,
    name: "durationMs-nonnegative",
    async check(adapter) {
      let now = 0;
      const scope = adapter.createScope();
      scope.register(
        descriptor("a", () => {
          now += 3;
          return { ok: true };
        })
      );
      const [result] = await scope.run([{ id: "1", tool: "a", input: {} }], { clock: () => now });
      expect(result?.durationMs).toBeGreaterThanOrEqual(0);
    },
  },
  {
    id: 6,
    name: "late-update-dropped",
    async check(adapter) {
      const events: unknown[] = [];
      let captured: ToolExecuteContext | undefined;
      const scope = adapter.createScope();
      scope.register(
        descriptor("a", (_input, exec) => {
          captured = exec;
          exec.onUpdate("early");
          return { ok: true };
        })
      );
      await scope.run([{ id: "1", tool: "a", input: {} }], {
        onUpdate: (update) => events.push(update.partialResult),
      });
      expect(events).toEqual(["early"]);
      captured?.onUpdate("late");
      expect(events).toEqual(["early"]);
    },
  },
  {
    id: 7,
    name: "input-allowlist",
    async check(adapter) {
      const tool: ToolDescriptor = { ...descriptor("a", () => ({ ok: true })), inputSchema: ["q"] };
      expect(() => adapter.validate(tool, { q: 1, x: 2 })).toThrow("TOOL_INPUT_EXTRA_FIELD");
      const scope = adapter.createScope();
      scope.register(tool);
      const [result] = await scope.run([{ id: "1", tool: "a", input: { q: 1, x: 2 } }]);
      expect(result?.isError).toBe(true);
    },
  },
  {
    id: 8,
    name: "dependency-fail-closed",
    async check(adapter) {
      let executed = 0;
      const scope = adapter.createScope();
      scope.register(descriptor("a", () => undefined));
      scope.register(
        descriptor("b", () => {
          executed += 1;
          return { ok: true };
        })
      );
      const results = await scope.run([
        { id: "a", tool: "a", input: {} },
        { id: "b", tool: "b", input: {}, dependsOn: ["a"] },
      ]);
      expect(executed).toBe(0);
      expect(results[1]?.reason).toContain("TOOL_DEPENDENCY_UNSATISFIED");
    },
  },
  {
    id: 9,
    name: "terminate-all",
    async check(adapter) {
      const executed: string[] = [];
      const scope = adapter.createScope();
      scope.register(
        descriptor("a", (_input, exec) => {
          executed.push("a");
          exec.terminate();
          return { ok: true };
        })
      );
      scope.register(
        descriptor("b", () => {
          executed.push("b");
          return { ok: true };
        })
      );
      const controller = createTerminationController();
      const results = await scope.run(
        [
          { id: "a", tool: "a", input: {} },
          { id: "b", tool: "b", input: {}, dependsOn: ["a"] },
        ],
        { controller }
      );
      expect(executed).toEqual(["a"]);
      expect(results[1]?.reason).toContain("BATCH_TERMINATED");
    },
  },
  {
    id: 10,
    name: "parallel-allsettled",
    async check(adapter) {
      const scope = adapter.createScope();
      scope.register(
        descriptor("a", () => {
          throw new Error("boom");
        })
      );
      scope.register(descriptor("b", () => ({ ok: true })));
      const results = await scope.run([
        { id: "a", tool: "a", input: {} },
        { id: "b", tool: "b", input: {} },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]?.isError).toBe(true);
      expect(results[1]?.isError).toBe(false);
    },
  },
  {
    id: 11,
    name: "verdict-order-stable",
    check(adapter) {
      expect(adapter.evaluate([{ behavior: "ALLOW" }, { behavior: "ASK" }]).behavior).toBe("ASK");
      expect(adapter.evaluate([{ behavior: "ASK" }, { behavior: "ALLOW" }]).behavior).toBe("ASK");
    },
  },
  {
    id: 12,
    name: "bypass-immune",
    check(adapter) {
      expect(adapter.evaluate([{ behavior: "DENY", bypassImmune: true }], true).behavior).toBe("DENY");
      expect(adapter.evaluate([{ behavior: "DENY" }], true).behavior).not.toBe("DENY");
    },
  },
];

for (const adapter of ADAPTERS) {
  describe(`T-17 invariants (${adapter.kind})`, () => {
    expect(INVARIANTS).toHaveLength(12);
    for (const invariant of INVARIANTS) {
      test(`I${invariant.id} ${invariant.name}`, async () => {
        await invariant.check(adapter);
      });
    }
  });
}
