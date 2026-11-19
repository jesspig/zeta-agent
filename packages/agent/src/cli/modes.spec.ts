import { describe, expect, test } from "bun:test";
import { createAgent } from "../facade";
import {
  MODES,
  createCliFacade,
  decodeRpcFrame,
  encodeRpcFrame,
  encodeRpcRequest,
  modeNames,
  selectMode,
} from "./modes";

function testAgent() {
  return createAgent({
    streamFn: async function* () {
      yield "done";
    },
  });
}

function collector() {
  const lines: string[] = [];
  return {
    lines,
    output: (line: string) => {
      lines.push(line);
    },
  };
}

describe("T-26 CLI facade and mode plugins", () => {
  test("four modes are registered behind one run interface", () => {
    expect(modeNames()).toEqual(["interactive", "print", "json", "rpc"]);
    for (const name of modeNames()) {
      expect(MODES[name].name).toBe(name);
      expect(typeof MODES[name].run).toBe("function");
    }
    expect(MODES.interactive.requiresTTY).toBe(true);
  });

  test("print mode emits readable transcript lines", async () => {
    const sink = collector();
    const code = await MODES.print.run(testAgent(), { prompt: "hi", output: sink.output });

    expect(code).toBe(0);
    expect(sink.lines.length).toBeGreaterThan(0);
    expect(sink.lines.join("\n")).toContain("hi");
    expect(sink.lines.join("\n")).toContain("done");
  });

  test("json mode emits parseable JSON lines", async () => {
    const sink = collector();
    const code = await MODES.json.run(testAgent(), { prompt: "hi", output: sink.output });

    expect(code).toBe(0);
    const parsed = sink.lines.map((line) => JSON.parse(line));
    expect(parsed.length).toBeGreaterThan(0);
    for (const frame of parsed) {
      expect(typeof frame.type).toBe("string");
    }
    expect(parsed.some((frame) => frame.type === "message_end")).toBe(true);
  });

  test("rpc frames round-trip and rpc mode answers requests", async () => {
    const encoded = encodeRpcFrame({ id: 1, result: { ok: true } });
    expect(encoded).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(decodeRpcFrame(encoded)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    expect(() => decodeRpcFrame("not-json")).toThrow();

    const sink = collector();
    const request = encodeRpcRequest({ id: 7, method: "prompt", params: { text: "hi" } });
    const code = await MODES.rpc.run(testAgent(), { lines: [request], output: sink.output });

    expect(code).toBe(0);
    expect(sink.lines).toHaveLength(1);
    const response = JSON.parse(sink.lines[0] ?? "");
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(7);
    expect(response.result).toBeDefined();
  });

  test("print/json/rpc work without a TTY and interactive processes scripted lines", async () => {
    for (const name of ["print", "json", "rpc"] as const) {
      expect(MODES[name].requiresTTY).toBe(false);
      const sink = collector();
      const code = await MODES[name].run(testAgent(), {
        prompt: "hi",
        lines: [encodeRpcRequest({ id: 1, method: "prompt", params: { text: "hi" } })],
        output: sink.output,
        tty: false,
      });
      expect(code).toBe(0);
      expect(sink.lines.length).toBeGreaterThan(0);
    }

    const sink = collector();
    const code = await MODES.interactive.run(testAgent(), {
      lines: ["hello"],
      output: sink.output,
    });
    expect(code).toBe(0);
    expect(sink.lines.join("\n")).toContain("hello");
  });

  test("CLI facade selects a mode and rejects unknown names", async () => {
    const cli = createCliFacade();
    expect(selectMode("json").name).toBe("json");
    expect(() => selectMode("bogus")).toThrow();

    const sink = collector();
    const code = await cli.run("print", testAgent(), { prompt: "hi", output: sink.output });
    expect(code).toBe(0);
    expect(sink.lines.length).toBeGreaterThan(0);
  });
});
