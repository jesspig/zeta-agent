import { createSignal } from "solid-js";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { useTheme } from "../theme-context";
import { clampWidth } from "./layout";

const DEFAULT_WIDTH = 56;

export interface ConnectDialogProps {
  readonly initialUrl?: string;
  readonly initialKey?: string;
  readonly onSubmit: (url: string, key: string) => void;
  readonly onCancel: () => void;
}

type Field = "url" | "key";

/** 双字段连接对话框：现场输入 Base URL 与 API Key（仅内存，不落盘）。 */
export function ConnectDialog(props: ConnectDialogProps) {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const [url, setUrl] = createSignal(props.initialUrl ?? "");
  const [key, setKey] = createSignal(props.initialKey ?? "");
  const [field, setField] = createSignal<Field>("url");
  const [width] = createSignal(clampWidth(DEFAULT_WIDTH, dimensions().width));

  const current = () => (field() === "url" ? url() : key());
  const setCurrent = (value: string) => (field() === "url" ? setUrl(value) : setKey(value));
  const masked = (value: string) => (field() === "url" ? value : "*".repeat(value.length));

  useKeyboard((event) => {
    if (event.eventType === "release") return;
    event.preventDefault();
    event.stopPropagation();
    const name = event.name;
    if (name === "escape" || (event.ctrl && name === "c")) {
      props.onCancel();
      return;
    }
    if (name === "tab" || name === "down" || name === "up") {
      setField((value) => (value === "url" ? "key" : "url"));
      return;
    }
    if (name === "return" || name === "enter") {
      if (field() === "url") {
        setField("key");
      } else if (url().trim().length > 0 && key().trim().length > 0) {
        props.onSubmit(url().trim(), key().trim());
      }
      return;
    }
    if (name === "backspace") {
      setCurrent(current().slice(0, -1));
      return;
    }
    // 优先使用保留原始文本的 sequence（传统键盘路径下 name 会被规范化为小写），
    // 仅在 sequence 不是单字符打印文本时回退到 name，避免丢失凭据大小写。
    const typed = event.sequence;
    const character = typeof typed === "string" && typed.length === 1 ? typed : name;
    if (character.length === 1 && !event.ctrl && !event.meta) {
      setCurrent(current() + character);
    }
  });

  // 粘贴 Key/URL：从 bracketed paste 字节流提取原文，去掉控制序列后写入当前字段。
  // Key 通常是长随机串，必须支持整段粘贴而非逐字符输入。
  const decoder = new TextDecoder();
  usePaste((event) => {
    const raw = decoder.decode(event.bytes);
    const text = raw
      .replace(/\x1b\[20[012]~/g, "")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\r?\n/g, "");
    if (text.length === 0) return;
    event.preventDefault();
    setCurrent(current() + text);
  });

  return (
    <box flexDirection="column" border={true} title="连接 API" width={width()} height={7}>
      <text fg={field() === "url" ? theme.color("accent") : theme.color("muted")}>
        {`Base URL: ${field() === "url" ? masked(url()) : url() || "(输入 API 基址)"}`}
      </text>
      <text fg={field() === "key" ? theme.color("accent") : theme.color("muted")}>
        {`API Key : ${field() === "key" ? masked(key()) : key().length > 0 ? "••••••" : "(输入密钥)"}`}
      </text>
      <text fg={theme.color("muted")}>{"[Tab] 切换字段  [Enter] 提交  [Esc] 取消"}</text>
    </box>
  );
}
