import { createContext, useContext, type ParentProps } from "solid-js";
import { createOscReporter, type OscReporter } from "./osc";

const NOOP_REPORTER = createOscReporter(() => {});

const OscContext = createContext<OscReporter>(NOOP_REPORTER);

export interface OscProviderProps extends ParentProps {
  readonly reporter: OscReporter;
}

/** 终端协议上报上下文：产线由 renderTui 注入写 stdout 的 reporter，测试注入 spy。 */
export function OscProvider(props: OscProviderProps) {
  return <OscContext.Provider value={props.reporter}>{props.children}</OscContext.Provider>;
}

export function useOsc(): OscReporter {
  return useContext(OscContext) ?? NOOP_REPORTER;
}
