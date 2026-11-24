export interface DeferredTelemetry {
  readonly started: boolean;
  readonly done: Promise<void>;
  start(): Promise<void>;
}

/** 遥测激活只在显式 start 后发生，失败经 done 暴露而不冒泡阻塞调用方。 */
export function createDeferredTelemetry(load: () => Promise<void>): DeferredTelemetry {
  let started = false;
  let done: Promise<void> = Promise.resolve();
  return {
    get started() {
      return started;
    },
    get done() {
      return done;
    },
    start() {
      if (started) return done;
      started = true;
      done = Promise.resolve().then(load);
      return done;
    },
  };
}

/** 首帧渲染与遥测激活的分界：render 在前，激活不参与 await。 */
export async function withFirstFrame<T>(deps: {
  render(): Promise<T>;
  afterFirstFrame(): Promise<void>;
}): Promise<T> {
  const frame = await deps.render();
  const activation = deps.afterFirstFrame();
  void Promise.resolve(activation).catch(() => {});
  return frame;
}
