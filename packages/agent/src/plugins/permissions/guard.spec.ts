import { describe, expect, test } from "bun:test";
import { createPermissionGate } from "./guard";

describe("T-18 stage-scoped permission gate", () => {
  test("undeclared stage tool is rejected by the build-time layer", async () => {
    const gate = createPermissionGate();
    gate.declareTools([{ tool: "search", stages: ["plan"] }]);
    expect(gate.toolsForStage("plan")).toEqual(["search"]);
    expect(gate.toolsForStage("build")).toEqual([]);

    const allowed = await gate.authorize("plan", "search", {});
    expect(allowed.behavior).toBe("ALLOW");

    const denied = await gate.authorize("plan", "execute", {});
    expect(denied.behavior).toBe("DENY");
    expect(denied.reason).toContain("STAGE_TOOL_UNDECLARED");
  });

  test("beforeToolCall hooks run in registration order", async () => {
    const gate = createPermissionGate();
    gate.declareTools([{ tool: "search", stages: ["plan"] }]);
    const order: string[] = [];
    gate.addBeforeToolCall((_context, next) => {
      order.push("a");
      next({ behavior: "ALLOW" });
    });
    gate.addBeforeToolCall(async (_context, next) => {
      order.push("b");
      await Promise.resolve();
      next({ behavior: "ALLOW" });
    });

    const decision = await gate.authorize("plan", "search", {});
    expect(order).toEqual(["a", "b"]);
    expect(decision.behavior).toBe("ALLOW");
    expect(gate.hookCount).toBe(2);
  });

  test("a rejection cannot be flipped by a later allow", async () => {
    const gate = createPermissionGate();
    gate.declareTools([{ tool: "search", stages: ["plan"] }]);
    gate.addBeforeToolCall((_context, next) => next({ behavior: "DENY", reason: "blocked" }));
    gate.addBeforeToolCall((_context, next) => next({ behavior: "ALLOW" }));
    const hookDenial = await gate.authorize("plan", "search", {});
    expect(hookDenial.behavior).toBe("DENY");
    expect(hookDenial.reason).toContain("blocked");

    const other = createPermissionGate();
    other.addBeforeToolCall((_context, next) => next({ behavior: "ALLOW" }));
    const buildDenial = await other.authorize("plan", "execute", {});
    expect(buildDenial.behavior).toBe("DENY");
    expect(buildDenial.reason).toContain("STAGE_TOOL_UNDECLARED");
  });

  test("ask fails closed", async () => {
    const gate = createPermissionGate();
    gate.declareTools([{ tool: "search", stages: ["plan"] }]);
    gate.addBeforeToolCall((_context, next) => next({ behavior: "ASK", reason: "confirm" }));
    const decision = await gate.authorize("plan", "search", {});
    expect(decision.behavior).toBe("ASK");
    expect(decision.reason).toContain("confirm");
  });

  test("calling next twice throws and a disposer removes the hook", async () => {
    const gate = createPermissionGate();
    const dispose = gate.addBeforeToolCall((_context, next) => {
      next({ behavior: "ALLOW" });
    });
    expect(gate.hookCount).toBe(1);
    dispose();
    expect(gate.hookCount).toBe(0);

    gate.addBeforeToolCall((_context, next) => {
      next({ behavior: "ALLOW" });
      next({ behavior: "ALLOW" });
    });
    let message = "";
    try {
      await gate.authorize("plan", "search", {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("BEFORE_TOOL_CALL_NEXT_TWICE");
  });

  test("gates are isolated with no implicit global state", async () => {
    const first = createPermissionGate();
    const second = createPermissionGate();
    first.declareTools([{ tool: "a", stages: ["s"] }]);
    expect(first.toolsForStage("s")).toEqual(["a"]);
    expect(second.toolsForStage("s")).toEqual([]);
    expect((await second.authorize("s", "a", {})).behavior).toBe("DENY");
  });

  test("declaration disposer removes only its own stage grants", async () => {
    const gate = createPermissionGate();
    const keep = gate.declareTools([{ tool: "search", stages: ["plan"] }]);
    const drop = gate.declareTools([{ tool: "execute", stages: ["plan"] }]);
    expect(gate.toolsForStage("plan")).toEqual(["execute", "search"]);
    drop();
    expect(gate.toolsForStage("plan")).toEqual(["search"]);
    keep();
    expect(gate.toolsForStage("plan")).toEqual([]);
    expect((await gate.authorize("plan", "search", {})).behavior).toBe("DENY");
  });
});
