import type { ObjectTelemetry } from "@zeta-agent/framework";

export interface TelemetryActivation {
  readonly sink: ObjectTelemetry;
}

/** 重遥测模块只在首帧之后动态加载；此文件本身不在入口顶层出现。 */
export async function activateTelemetry(): Promise<TelemetryActivation> {
  const { createObjectTelemetry } = await import("@zeta-agent/framework");
  const sink = createObjectTelemetry();
  sink.emit({ ts: Date.now(), kind: "serve", detail: "zeta telemetry activated" });
  return { sink };
}
