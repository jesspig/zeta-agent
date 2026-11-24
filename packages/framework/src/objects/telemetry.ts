import { ContractError } from "./contract";
import { AdmissionError } from "./admission";

/** 对象错误分类：与 contract/admission/fiber 的失败原因一一对应。 */
export type ObjectErrorClass =
  | "CONTRACT"
  | "ADMISSION"
  | "FACTORY"
  | "LIFECYCLE"
  | "TIMEOUT"
  | "UNKNOWN";

export type ObjectEventKind =
  | "serve"
  | "load"
  | "get"
  | "hold"
  | "release"
  | "reload"
  | "restart"
  | "retry"
  | "park"
  | "end"
  | "admission"
  | "error";

export interface ObjectEvent {
  readonly ts: number;
  readonly kind: ObjectEventKind;
  readonly contract?: string;
  readonly generation?: number;
  readonly principal?: string;
  readonly realm?: string;
  readonly errorClass?: ObjectErrorClass;
  readonly detail?: string;
}

export interface ObjectTelemetry {
  emit(event: ObjectEvent): void;
  readonly events: readonly ObjectEvent[];
  clear(): void;
}

/** reload 排空超时：新调用等待新代码超过上限仍不能就绪。 */
export class ObjectTimeoutError extends Error {
  readonly kind = "TIMEOUT" as const;
  constructor(message = "OBJECT_RELOAD_TIMEOUT") {
    super(message);
    this.name = "ObjectTimeoutError";
  }
}

/** 对象取消/撤销：release 后的旧调用不能继续使用已释放的值。 */
export class ObjectReleasedError extends Error {
  readonly kind = "LIFECYCLE" as const;
  constructor(message = "OBJECT_RELEASED") {
    super(message);
    this.name = "ObjectReleasedError";
  }
}

export function createObjectTelemetry(onEvent?: (event: ObjectEvent) => void): ObjectTelemetry {
  const events: ObjectEvent[] = [];
  return {
    emit(event) {
      events.push(event);
      onEvent?.(event);
    },
    get events(): readonly ObjectEvent[] {
      return events;
    },
    clear() {
      events.length = 0;
    },
  };
}

export function classifyObjectError(error: unknown): ObjectErrorClass {
  if (error instanceof ContractError) return "CONTRACT";
  if (error instanceof AdmissionError) return "ADMISSION";
  if (error instanceof ObjectTimeoutError) return "TIMEOUT";
  if (error instanceof ObjectReleasedError) return "LIFECYCLE";
  if (error instanceof Error && /FIBER_|UNLOADING|DISPOSED|OBJECT_RELEASED/.test(error.message)) {
    return "LIFECYCLE";
  }
  return "FACTORY";
}
