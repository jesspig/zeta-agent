import { createContext, createSignal, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js";
import { createThemeRegistry, type ColorToken, type ThemeName } from "./theme";

export interface ThemeView {
  readonly color: (token: ColorToken) => string;
  readonly name: Accessor<string>;
  readonly setActive: (name: string) => void;
}

const ThemeContext = createContext<ThemeView>();

export interface ThemeProviderProps extends ParentProps {
  readonly initial?: ThemeName;
}

/** 主题 Provider：token 色值随 registry.setActive 精细更新，不重启 Solid fiber。 */
export function ThemeProvider(props: ThemeProviderProps) {
  const registry = createThemeRegistry();
  const [name, setName] = createSignal<string>(props.initial ?? "dark");
  registry.setActive(props.initial ?? "dark");
  const off = registry.subscribe(() => setName(registry.active()));
  onCleanup(off);
  const view: ThemeView = {
    color: (token) => registry.activeTheme().color(token),
    name,
    setActive: (next) => registry.setActive(next),
  };
  return <ThemeContext.Provider value={view}>{props.children}</ThemeContext.Provider>;
}

/** 读取当前主题 token 色；无 Provider 时回退 dark 调色板，保证组件独立可测。 */
export function useTheme(): ThemeView {
  const view = useContext(ThemeContext);
  if (view !== undefined) return view;
  const fallback = createThemeRegistry();
  return {
    color: (token) => fallback.theme("dark").color(token),
    name: () => "dark",
    setActive: () => {},
  };
}
