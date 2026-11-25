import type { Disposer } from "@zeta-agent/framework";
import type { AgentStreamChunk, AgentStreamFn, AgentStreamRequest } from "../facade";
import { classifyProviderError, withProviderRetry, type ProviderRetryOptions } from "./retry";

export interface ProviderRegistrationOptions {
  readonly models?: readonly string[];
  /** 注入的兼容 streamFn 可声明 passthrough：EOF 无 terminal 时保持原样，不归一化为错误。 */
  readonly terminalPolicy?: "normalize" | "passthrough";
}

export interface ProviderBrokerOptions {
  readonly routes?: Readonly<Record<string, readonly string[]>>;
  readonly fallback?: readonly string[];
  readonly retry?: ProviderRetryOptions;
  readonly onRoute?: (route: string, request: AgentStreamRequest) => void;
  readonly onPayload?: (provider: string, request: AgentStreamRequest) => void;
  readonly onResponse?: (provider: string, chunk: Extract<AgentStreamChunk, { type: "done" | "error" }>) => void;
  readonly onProviderStreamEvent?: (provider: string, chunk: AgentStreamChunk) => void;
}

export interface ProviderBroker {
  register(id: string, streamFn: AgentStreamFn, options?: ProviderRegistrationOptions): Disposer;
  unregister(id: string): void;
  setRoutes(routes: Readonly<Record<string, readonly string[]>>): void;
  setFallback(providerIds: readonly string[]): void;
  resolve(request: AgentStreamRequest): readonly string[];
  stream(request: AgentStreamRequest): AsyncIterable<AgentStreamChunk>;
}

interface Registration {
  readonly id: string;
  readonly streamFn: AgentStreamFn;
  readonly models?: readonly string[];
  readonly terminalPolicy: "normalize" | "passthrough";
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function createProviderBroker(options: ProviderBrokerOptions = {}): ProviderBroker {
  let routes = new Map(Object.entries(options.routes ?? {}));
  let fallback = [...(options.fallback ?? [])];
  const registrations = new Map<string, Registration>();

  function resolve(request: AgentStreamRequest): readonly string[] {
    if (request.provider !== undefined) return unique([request.provider, ...fallback]);
    const provider = request.model?.split(/[/:]/)[0];
    const explicit = unique([
      ...(request.model !== undefined ? routes.get(request.model) ?? [] : []),
      ...(provider !== undefined ? routes.get(provider) ?? [] : []),
      ...(routes.get("*") ?? []),
    ]);
    return unique([
      ...(explicit.length > 0 ? explicit : provider !== undefined ? [provider] : []),
      ...fallback,
    ]);
  }

  return {
    register(id, streamFn, registrationOptions = {}) {
      if (typeof id !== "string" || id.length === 0) throw new Error("provider.register: id required");
      if (typeof streamFn !== "function") throw new Error("provider.register: streamFn required");
      const registration: Registration = {
        id,
        streamFn,
        terminalPolicy: registrationOptions.terminalPolicy ?? "normalize",
        ...(registrationOptions.models !== undefined ? { models: registrationOptions.models } : {}),
      };
      registrations.set(id, registration);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (registrations.get(id) === registration) registrations.delete(id);
      };
    },
    unregister(id) {
      registrations.delete(id);
    },
    setRoutes(next) {
      routes = new Map(Object.entries(next));
    },
    setFallback(providerIds) {
      fallback = [...providerIds];
    },
    resolve,
    stream(request) {
      const route = resolve(request);
      const snapshot = route.map((id) => registrations.get(id));
      return (async function* () {
        if (snapshot.every((entry) => entry === undefined)) {
          const error = { code: "provider_not_found", message: `PROVIDER_NOT_FOUND: ${route.join(", ") || "unrouted"}` };
          options.onRoute?.(route[0] ?? "", request);
          yield { type: "error", error };
          return;
        }
        let emitted = false;
        for (const registration of snapshot) {
          if (registration === undefined) continue;
          const provider = registration.id;
          options.onRoute?.(provider, request);
          options.onPayload?.(provider, request);
          const retryOptions = options.retry ?? { maxRetries: 0 };
          const recovered = registration.terminalPolicy === "passthrough"
            ? registration.streamFn
            : withProviderRetry(registration.streamFn, retryOptions);
          try {
            for await (const chunk of recovered(request)) {
              options.onProviderStreamEvent?.(provider, chunk);
              if (typeof chunk === "object" && (chunk.type === "done" || chunk.type === "error")) options.onResponse?.(provider, chunk);
              if (typeof chunk === "object" && chunk.type === "error") {
                if (!emitted) break;
                yield chunk;
                return;
              }
              if (typeof chunk !== "string" || chunk.length > 0) emitted = true;
              yield chunk;
              if (typeof chunk === "object" && chunk.type === "done") return;
            }
          } catch (value) {
            const error = classifyProviderError(value).error;
            options.onProviderStreamEvent?.(provider, { type: "error", error });
            options.onResponse?.(provider, { type: "error", error });
            if (!emitted) continue;
            yield { type: "error", error };
            return;
          }
          // 兼容注入的 streamFn 没有终态时已在本次产出内容：不再把同一请求交给 fallback 重放。
          if (registration.terminalPolicy === "passthrough" && emitted) return;
        }
        if (!emitted) {
          const error = { code: "provider_unavailable", message: `PROVIDER_UNAVAILABLE: ${route.join(", ")}` };
          yield { type: "error", error };
        }
      })();
    },
  };
}
