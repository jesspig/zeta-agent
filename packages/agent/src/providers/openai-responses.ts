import type { AgentMessage, AgentStreamChunk, AgentStreamFn, AgentStreamRequest, AgentToolSchema } from "../facade";

export interface OpenAiResponsesConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

interface ResponsesEvent {
  readonly type?: string;
  readonly delta?: string;
  readonly arguments?: string;
  readonly output_index?: number;
  readonly item?: {
    readonly type?: string;
    readonly id?: string;
    readonly call_id?: string;
    readonly name?: string;
    readonly arguments?: string;
  };
  readonly response?: {
    readonly status?: string;
    readonly error?: { readonly code?: string; readonly message?: string };
  };
  readonly code?: string;
  readonly message?: string;
}

interface CallSlot {
  readonly type: "function_call";
  callId: string;
  name: string;
  args: string;
}

function toParameters(schema: AgentToolSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of schema.parameters) {
    properties[parameter.name] = {
      type: parameter.type,
      description: parameter.description,
    };
    if (parameter.required === true) required.push(parameter.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** 把内部消息映射为 Responses input（system 走 instructions，不在 input 内）。 */
function toResponsesInput(messages: readonly AgentMessage[]): readonly Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "toolResult") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "call-1",
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      if (typeof message.content === "string" && message.content.length > 0) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    input.push({
      role: message.role,
      content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text }],
    });
  }
  return input;
}

async function* parseResponsesSse(body: ReadableStream<Uint8Array>): AsyncIterableIterator<AgentStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const slots = new Map<number, CallSlot>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0 || payload === "[DONE]") continue;
        let event: ResponsesEvent;
        try {
          event = JSON.parse(payload) as ResponsesEvent;
        } catch {
          continue;
        }
        if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
          slots.set(event.output_index ?? slots.size, {
            type: "function_call",
            callId: event.item.call_id ?? event.item.id ?? "call-1",
            name: event.item.name ?? "",
            args: event.item.arguments ?? "",
          });
        } else if (
          event.type === "response.reasoning_summary_text.delta" ||
          event.type === "response.reasoning_text.delta"
        ) {
          if (typeof event.delta === "string" && event.delta.length > 0) {
            yield { type: "reasoning", text: event.delta };
          }
        } else if (event.type === "response.output_text.delta") {
          if (typeof event.delta === "string" && event.delta.length > 0) yield event.delta;
        } else if (event.type === "response.function_call_arguments.delta") {
          const slot = slots.get(event.output_index ?? 0);
          if (slot !== undefined && typeof event.delta === "string") slot.args += event.delta;
        } else if (event.type === "response.function_call_arguments.done") {
          const slot = slots.get(event.output_index ?? 0);
          if (slot !== undefined && typeof event.arguments === "string") slot.args = event.arguments;
        } else if (event.type === "response.output_item.done") {
          const slot = slots.get(event.output_index ?? 0);
          if (slot !== undefined && slot.type === "function_call") {
            const args = event.item?.arguments;
            yield {
              type: "tool_call",
              id: slot.callId,
              name: slot.name,
              arguments: typeof args === "string" && args.length > 0 ? args : slot.args,
            };
            slots.delete(event.output_index ?? 0);
          }
        } else if (event.type === "error") {
          throw new Error(`OPENAI_RESPONSES_ERROR ${event.code ?? "unknown"}: ${event.message ?? "no message"}`);
        } else if (event.type === "response.failed") {
          const error = event.response?.error;
          throw new Error(
            `OPENAI_RESPONSES_FAILED ${error?.code ?? "unknown"}: ${error?.message ?? "no message"}`
          );
        }
      }
    }
  }
  for (const slot of slots.values()) {
    if (slot.name.length === 0) continue;
    yield { type: "tool_call", id: slot.callId, name: slot.name, arguments: slot.args };
  }
}

/** OpenAI Responses API 流式实现：/responses + instructions/input，SSE 事件产出文本/推理/工具调用。 */
export function createOpenAiResponsesStreamFn(
  config: OpenAiResponsesConfig,
  fetchImpl: typeof fetch = fetch
): AgentStreamFn {
  return async function* (request: AgentStreamRequest) {
    const url = `${config.baseUrl.replace(/\/+$/, "")}/responses`;
    const instructions = request.messages
      .filter((message) => message.role === "system")
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
      .join("\n");
    const tools = request.tools;
    const body: Record<string, unknown> = {
      model: config.model,
      input: toResponsesInput(request.messages),
      stream: true,
      ...(instructions.length > 0 ? { instructions } : {}),
      ...(request.reasoningEffort !== undefined ? { reasoning: { effort: request.reasoningEffort } } : {}),
      ...(tools !== undefined && tools.length > 0
        ? { tools: tools.map((schema) => ({ type: "function", name: schema.name, description: schema.description, parameters: toParameters(schema) })) }
        : {}),
    };
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (!response.ok) {
      const hint =
        response.status === 401
          ? "请检查 ZETA_API_KEY"
          : response.status === 429
            ? "请求被限流或额度不足，请稍后重试"
            : response.status === 404
              ? "请检查 ZETA_BASE_URL 与 ZETA_MODEL"
              : "";
      throw new Error(`OPENAI_RESPONSES_HTTP_${response.status}${hint ? ` (${hint})` : ""}`);
    }
    if (response.body === null) throw new Error("OPENAI_RESPONSES_NO_BODY");
    yield* parseResponsesSse(response.body);
  };
}
