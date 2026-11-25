import type { Disposer } from "@zeta-agent/cordis/types";

export interface Events {}

export type EventName = keyof Events & string;

export type Listener<N extends EventName> = (
  payload: Events[N],
  ...rest: any[]
) => unknown | Promise<unknown>;

export type WaterfallListener<N extends EventName> = (
  payload: Events[N],
  next: (value: Events[N]) => void
) => void | Promise<void>;

export interface DispatchOptions {
  readonly scope?: symbol;
}

export interface EventBus {
  on<N extends EventName>(name: N, listener: Listener<N>, opts?: DispatchOptions): Disposer;
  emit<N extends EventName>(name: N, payload: Events[N], opts?: DispatchOptions): void;
  parallel<N extends EventName>(name: N, payload: Events[N], opts?: DispatchOptions): Promise<void>;
  serial<N extends EventName>(name: N, payload: Events[N], opts?: DispatchOptions): Promise<unknown>;
  bail<N extends EventName>(name: N, payload: Events[N], opts?: DispatchOptions): Promise<boolean>;
  waterfall<N extends EventName>(
    name: N,
    payload: Events[N],
    opts?: DispatchOptions
  ): Promise<Events[N]>;
}
