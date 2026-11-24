import { For, createMemo, type JSX } from "solid-js";
import { createVariableLayout, visibleRange } from "../virtual";

export interface VirtualListProps<T> {
  readonly items: readonly T[];
  readonly estimateHeight: (item: T, index: number) => number;
  readonly viewportHeight: number;
  readonly scrollTop?: number;
  readonly overscan?: number;
  /** 关闭时退化为完整渲染：短会话保持原有逐条布局与帧快照。 */
  readonly enabled?: boolean;
  /** 测试 seam：每次真正实例化一个条目时回调，用于统计渲染节点数。 */
  readonly onRenderItem?: (item: T, index: number) => void;
  readonly children: (item: T, index: number) => JSX.Element;
}

interface VisibleItem<T> {
  readonly item: T;
  readonly index: number;
}

/** 纯 layout 驱动的虚拟列表：只实例化可见条目，空白由上下占位盒承担。 */
export function VirtualList<T>(props: VirtualListProps<T>): JSX.Element {
  const layout = createMemo(() =>
    createVariableLayout(props.items.length, (index) => props.estimateHeight(props.items[index]!, index)),
  );
  const range = createMemo(() =>
    visibleRange(layout(), props.scrollTop ?? 0, props.viewportHeight, props.overscan ?? 0),
  );
  const enabled = (): boolean => props.enabled !== false;
  const rendered = createMemo<readonly VisibleItem<T>[]>(() => {
    if (!enabled()) return props.items.map((item, index) => ({ item, index }));
    const { start, end } = range();
    const out: VisibleItem<T>[] = [];
    for (let index = start; index < end; index += 1) {
      const item = props.items[index];
      if (item !== undefined) out.push({ item, index });
    }
    return out;
  });
  // 只实例化窗口内条目；窗口之外的高度由布局模型记录，不生成占位节点，
  // 避免占位盒把可见条目顶出终端视口（OpenTUI 的 box 高度不会自动裁剪）。
  return (
    <box flexDirection="column" height={enabled() ? props.viewportHeight : undefined}>
      <For each={rendered()}>
        {(entry) => {
          props.onRenderItem?.(entry.item, entry.index);
          return <box flexDirection="column">{props.children(entry.item, entry.index)}</box>;
        }}
      </For>
    </box>
  );
}

/** 由文本内容推导稳定行高估计；长会话的虚拟窗口依赖它而非真实渲染后再测量。 */
export function estimateTextHeight(text: string, width: number, min = 1, max = 30): number {
  const usable = Math.max(1, width);
  const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / usable)), 0);
  return Math.max(min, Math.min(max, Math.ceil(lines)));
}
