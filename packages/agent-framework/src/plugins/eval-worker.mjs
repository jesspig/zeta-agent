/**
 * 插件隔离求值 worker（随包发布，由 process.execPath 在独立子进程启动）。
 *
 * 安全约束：
 * - 宿主只通过 stdin/stdout 的 JSON 行协议通信；不向 vm 传入任何宿主对象/函数。
 * - bridge 全部在 vm 内部用 initializer 脚本创建，因此 `handler.constructor.constructor`
 *   拿不到宿主 Function/process/fs/net；即便被突破也只影响本子进程。
 * - vm 关闭 strings/wasm codeGeneration；process/require/fetch/fs 在上下文中不可达。
 * - 顶层求值与 handler 调用都有超时；输出/贡献数量有上限。
 *
 * 该脚本本身是可信代码；不可信的只有 init.source。
 */
import { createHash } from "node:crypto";
import vm from "node:vm";

/**
 * 在 vm 上下文内部运行的初始化脚本。所有函数均为 vm realm 函数，
 * 不持有任何宿主引用。bridge 只产出可 JSON 序列化的贡献描述 + handler 占位 id。
 */
const INITIALIZER = String.raw`
(function () {
  "use strict";
  var contributions = [];
  var handlers = Object.create(null);
  var seq = 0;
  function nextId(prefix) { seq += 1; return prefix + ":" + seq; }
  function safe(value) {
    if (value === undefined) return null;
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { return String(value); }
  }
  function metaOf(source) {
    var out = {};
    if (source === null || typeof source !== "object") return out;
    var keys = ["order", "priority", "dependsOn", "replaceable", "required", "source", "digest"];
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (source[key] !== undefined) out[key] = safe(source[key]);
    }
    return out;
  }
  function withMeta(base, source) {
    var meta = metaOf(source);
    var out = {};
    var names = Object.keys(base).concat(Object.keys(meta));
    for (var i = 0; i < names.length; i += 1) out[names[i]] = names[i] in base ? base[names[i]] : meta[names[i]];
    return out;
  }
  function requireObject(value, label) {
    if (value === null || typeof value !== "object") throw new TypeError(label + ": object required");
    return value;
  }
  function requireHandler(value, label) {
    if (typeof value !== "function") throw new TypeError(label + ": handler must be a function");
    return value;
  }
  var bridge = {
    registerTool: function (tool) {
      requireObject(tool, "registerTool");
      if (typeof tool.name !== "string" || tool.name.length === 0) throw new TypeError("registerTool: name required");
      var handlerId = nextId("tool");
      handlers[handlerId] = tool.execute;
      var parameters = [];
      if (Array.isArray(tool.parameters)) {
        for (var i = 0; i < tool.parameters.length; i += 1) {
          var p = tool.parameters[i];
          if (p === null || typeof p !== "object") { parameters.push({ name: String(p), type: "string" }); continue; }
          var param = { name: String(p.name), type: String(p.type === undefined ? "string" : p.type) };
          if (p.description !== undefined) param.description = String(p.description);
          if (p.required !== undefined) param.required = Boolean(p.required);
          parameters.push(param);
        }
      }
      var toolData = {
        name: tool.name,
        parameters: parameters,
        handlerId: handlerId
      };
      if (tool.description !== undefined) toolData.description = String(tool.description);
      contributions.push(withMeta({ kind: "tool", tool: toolData }, tool));
    },
    on: function (event, handler) {
      requireHandler(handler, "on");
      var handlerId = nextId("hook");
      handlers[handlerId] = handler;
      contributions.push(withMeta({ kind: "hook", event: String(event), handlerId: handlerId }, handler));
    },
    addSection: function (text) {
      contributions.push(withMeta({ kind: "section", text: String(text) }, null));
    },
    wrap: function (name, handler) {
      requireHandler(handler, "wrap");
      var handlerId = nextId("wrap");
      handlers[handlerId] = handler;
      contributions.push(withMeta({ kind: "wrap", name: String(name), handlerId: handlerId }, handler));
    },
    task: function (name, handler) {
      requireHandler(handler, "task");
      var handlerId = nextId("task");
      handlers[handlerId] = handler;
      contributions.push(withMeta({ kind: "task", name: String(name), handlerId: handlerId }, handler));
    },
    provide: function (name, value) {
      contributions.push(withMeta({ kind: "service", name: String(name), value: safe(value) }, null));
    },
    onInstall: function (handler) {
      requireHandler(handler, "onInstall");
      handlers.install = handler;
    }
  };
  Object.freeze(bridge);
  globalThis.api = bridge;
  globalThis.__bridge = bridge;
  globalThis.__getResult = function () {
    return safe({
      contributions: contributions,
      installRegistered: typeof handlers.install === "function",
      handlerIds: Object.keys(handlers)
    });
  };
  globalThis.__invoke = async function (handlerId, eventJson) {
    var fn = handlers[handlerId];
    if (typeof fn !== "function") return { ok: false, error: "NO_HANDLER:" + String(handlerId) };
    try {
      var event = eventJson === null || eventJson === undefined ? undefined : JSON.parse(eventJson);
      var value = await fn(event);
      return { ok: true, value: safe(value) };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  };
})();
`;

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function digestOf(source) {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

async function* stdinLines(stream) {
  let buffer = "";
  stream.setEncoding?.("utf8");
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : String(chunk);
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.length > 0) yield line;
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

async function main() {
  const lines = stdinLines(process.stdin);
  const first = await lines.next();
  if (first.done !== true && typeof first.value === "string") {
    // 空行已在生成器里过滤；这里只可能出现有效首行。
  }
  let init;
  try {
    init = JSON.parse(first.value ?? "{}");
  } catch (error) {
    emit({ t: "result", ok: false, code: "PLUGIN_INIT_INVALID", error: String(error?.message ?? error) });
    return;
  }

  const source = init.source;
  const name = init.name;
  const limits = init.limits ?? {};
  const timeoutMs = typeof limits.timeoutMs === "number" ? limits.timeoutMs : 2000;
  const invokeTimeoutMs = typeof limits.invokeTimeoutMs === "number" ? limits.invokeTimeoutMs : 2000;
  const maxOutputBytes = typeof limits.maxOutputBytes === "number" ? limits.maxOutputBytes : 1024 * 1024;
  const maxContributions = typeof limits.maxContributions === "number" ? limits.maxContributions : 200;

  const fail = (code, error) => {
    const message = { t: "result", ok: false, code, error: String(error ?? code) };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") <= maxOutputBytes) emit(message);
    else emit({ t: "result", ok: false, code: "PLUGIN_OUTPUT_LIMIT", error: "PLUGIN_OUTPUT_LIMIT" });
  };

  if (typeof source !== "string" || typeof name !== "string" || typeof init.digest !== "string") {
    fail("PLUGIN_INIT_INVALID", "name/source/digest required");
    return;
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(init.digest)) {
    fail("PLUGIN_DIGEST_INVALID_FORMAT", "digest format");
    return;
  }
  if (digestOf(source) !== init.digest) {
    fail("PLUGIN_DIGEST_MISMATCH", "digest mismatch");
    return;
  }

  let context;
  try {
    const sandbox = Object.create(null);
    context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(INITIALIZER, context, { timeout: timeoutMs, displayErrors: true });
    vm.runInContext(source, context, { timeout: timeoutMs, displayErrors: true });
  } catch (error) {
    const text = String(error?.message ?? error);
    fail(/timed out|timeout/i.test(text) ? "PLUGIN_EVAL_TIMEOUT" : "PLUGIN_EVAL_FAILED", text);
    return;
  }

  let result;
  try {
    const serialized = vm.runInContext("JSON.stringify(__getResult())", context, { timeout: timeoutMs });
    result = JSON.parse(serialized);
  } catch (error) {
    fail("PLUGIN_RESULT_INVALID", error?.message ?? error);
    return;
  }
  if (!Array.isArray(result.contributions)) {
    fail("PLUGIN_RESULT_INVALID", "contributions must be an array");
    return;
  }
  if (result.contributions.length > maxContributions) {
    fail("PLUGIN_CONTRIBUTION_LIMIT", `contributions=${result.contributions.length}`);
    return;
  }
  const success = {
    t: "result",
    ok: true,
    name,
    contributions: result.contributions,
    installRegistered: result.installRegistered === true,
    handlerIds: Array.isArray(result.handlerIds) ? result.handlerIds : [],
    digest: init.digest,
  };
  if (Buffer.byteLength(JSON.stringify(success), "utf8") > maxOutputBytes) {
    fail("PLUGIN_OUTPUT_LIMIT", "serialized contributions exceed maxOutputBytes");
    return;
  }
  emit(success);

  // 求值后保持子进程存活，handler 仅通过 IPC 调用；不提供任何宿主能力给 vm。
  for await (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message?.t === "stop") break;
    if (message?.t !== "invoke" || typeof message.id !== "string") continue;
    try {
      const expression =
        "__invoke(" + JSON.stringify(String(message.handlerId)) + "," +
        JSON.stringify(JSON.stringify(message.event ?? null)) + ")";
      const pending = vm.runInContext(expression, context, { timeout: invokeTimeoutMs });
      const value = await pending;
      emit({
        t: "invokeResult",
        id: message.id,
        ...(value && typeof value === "object" ? value : { ok: false, error: "INVALID_INVOKE_RESULT" }),
      });
    } catch (error) {
      emit({ t: "invokeResult", id: message.id, ok: false, error: String(error?.message ?? error) });
    }
  }
}

main().catch((error) => {
  emit({ t: "result", ok: false, code: "PLUGIN_WORKER_FAILED", error: String(error?.message ?? error) });
});
