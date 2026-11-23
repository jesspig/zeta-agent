import type { AgentEvent } from "./runtime/agent";
import type {
  AfterHook,
  AgentPluginApi,
  AgentTool,
  BeforeHook,
  Capabilities,
  ContextTransform,
  Converter,
  CoreContextLike,
  EffectMeta,
  EventBus,
  FinishTurn,
  PrepareNextTurn,
  PrepareRequest,
  QueueSource,
  RedactRule,
  StreamFn,
} from "./types";

declare const api: AgentPluginApi;

// 1 registerTool
const tool: AgentTool<never> = { name: "read", execute: () => "ok" };
const registerToolDisposer: () => void = api.registerTool(tool);
// @ts-expect-error registerTool 必须提供 name
api.registerTool({ execute: () => "ok" });

// 2 onEvent
const onEventDisposer: () => void = api.onEvent((event: AgentEvent, signal) => {
  const eventType: string = event.type;
  void eventType;
  void signal;
});
// @ts-expect-error onEvent 的 handler 接收 AgentEvent，不是 string
api.onEvent((event: string) => { void event; });

// 3 addConverter
const converter: Converter = () => undefined;
const addConverterDisposer: () => void = api.addConverter(converter);
// @ts-expect-error Converter 只能返回 AgentEvent 或 undefined
api.addConverter(() => "not-an-event");

// 4 addContextTransform
const contextTransform: ContextTransform = (context) => context;
const addContextTransformDisposer: () => void = api.addContextTransform(contextTransform);
// @ts-expect-error ContextTransform 必须接受 unknown 入参
api.addContextTransform((context: string) => context);

// 5 addBeforeToolCall
const beforeHook: BeforeHook = (_event) => {};
const addBeforeToolCallDisposer: () => void = api.addBeforeToolCall(beforeHook);
// @ts-expect-error BeforeHook 接收 AgentEvent，不是 number
api.addBeforeToolCall((event: number) => { void event; });

// 6 addAfterToolCall
const afterHook: AfterHook = (_event) => {};
const addAfterToolCallDisposer: () => void = api.addAfterToolCall(afterHook);
// @ts-expect-error AfterHook 接收 AgentEvent，不是 number
api.addAfterToolCall((event: number) => { void event; });

// 7 addTurnBoundary
const finishTurn: FinishTurn = (_event) => {};
const addTurnBoundaryDisposer: () => void = api.addTurnBoundary(finishTurn);
// @ts-expect-error FinishTurn 接收 AgentEvent，不是 boolean
api.addTurnBoundary((event: boolean) => { void event; });

// 8 addPrepareRequest
const prepareRequest: PrepareRequest = (request) => request;
const addPrepareRequestDisposer: () => void = api.addPrepareRequest(prepareRequest);
// @ts-expect-error PrepareRequest 必须接受 unknown 入参
api.addPrepareRequest((request: string) => request);

// 9 addPrepareNextTurn
const prepareNextTurn: PrepareNextTurn = (context) => context;
const addPrepareNextTurnDisposer: () => void = api.addPrepareNextTurn(prepareNextTurn);
// @ts-expect-error PrepareNextTurn 必须接受 unknown 入参
api.addPrepareNextTurn((context: string) => context);

// 10 provideSteering
const steeringSource: QueueSource = { name: "steer", next: () => ({ role: "user", content: "x" }) };
const provideSteeringDisposer: () => void = api.provideSteering(steeringSource);
// @ts-expect-error QueueSource 必须提供 name
api.provideSteering({ next: () => undefined });

// 11 provideFollowUp
const followUpSource: QueueSource = { name: "followUp", next: () => ({ role: "user", content: "y" }) };
const provideFollowUpDisposer: () => void = api.provideFollowUp(followUpSource);
// @ts-expect-error QueueSource 必须提供 next
api.provideFollowUp({ name: "followUp" });

// 12 provideStreamFn
const streamFn: StreamFn = async function* () {
  yield "chunk";
};
const provideStreamFnDisposer: () => void = api.provideStreamFn(streamFn);
// @ts-expect-error StreamFn 必须返回 AsyncIterable
api.provideStreamFn(() => "not-iterable");

// 13 declareToolLoadout
api.declareToolLoadout([tool]);
// @ts-expect-error declareToolLoadout 返回 void，不是 disposer
const declareToolLoadoutDisposer: () => void = api.declareToolLoadout([]);

// 14 useContext
const context: CoreContextLike | undefined = api.useContext();
// @ts-expect-error useContext 可能返回 undefined
const requiredContext: CoreContextLike = api.useContext();

// 15 events
const events: EventBus = api.events;
// @ts-expect-error events 是只读属性
api.events = events;

// 16 capabilities
const capabilities: Capabilities = api.capabilities();
const active: boolean = capabilities.isolation === "active";
// @ts-expect-error capabilities() 返回 Capabilities，不是 boolean
const notCapabilities: boolean = api.capabilities();

// 17 onEffect
const stopEffect: () => void = api.onEffect((meta: EffectMeta) => {
  const label: string = meta.label;
  void label;
});
// @ts-expect-error onEffect 的 handler 接收 EffectMeta，不是 string
api.onEffect((meta: string) => { void meta; });

// 18 addRedactor
const redactRule: RedactRule = { match: /secret/g, replace: "[REDACTED]" };
const stopRedactor: () => void = api.addRedactor(redactRule);
// @ts-expect-error RedactRule.match 必须是 RegExp 或 string
api.addRedactor({ match: 42, replace: "x" });

export type { active, stopEffect, stopRedactor, capabilities };
