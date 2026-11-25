import type { EventBus } from "@zeta-agent/framework/events";

// 外部通过稳定 facade 入口声明 Events 类型合并。
declare module "@zeta-agent/events/types" {
  interface Events {
    "facade:ready": string;
  }
}

declare const bus: EventBus;

bus.emit("facade:ready", "ok");
bus.serial("facade:ready", "ok");
bus.bail("facade:ready", "ok");

// @ts-expect-error 未声明的事件名不可派发
bus.emit("facade:unknown", 1);

// @ts-expect-error 载荷类型与声明不匹配
bus.emit("facade:ready", 1);
