import type { EventBus } from "./events";

declare module "./types" {
  interface Events {
    "test:ok": string;
    "test:bad": number;
  }
}

declare const bus: EventBus;

bus.emit("test:ok", "value");
bus.emit("test:bad", 1);

// @ts-expect-error 非法事件名不在 Events 声明合并中
bus.emit("not-declared", 1);

// @ts-expect-error 事件载荷类型与声明不匹配
bus.emit("test:bad", "wrong");
