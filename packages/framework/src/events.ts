// typed events 的稳定 facade 入口：事件总线实现与 Events 声明合并类型都从这里取。
export { createEventBus, type EventBusOptions } from "@zeta-agent/events/events";
export type {
  DispatchOptions,
  EventBus,
  EventName,
  Events,
  Listener,
  WaterfallListener,
} from "@zeta-agent/events/types";
