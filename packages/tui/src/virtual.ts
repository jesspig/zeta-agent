export interface VisibleWindow {
  readonly start: number;
  readonly end: number;
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label}: expected a non-negative integer`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label}: expected a finite number`);
}

export function visibleWindow(
  totalRows: number,
  viewportHeight: number,
  scrollTop: number
): VisibleWindow {
  assertCount(totalRows, "totalRows");
  assertCount(viewportHeight, "viewportHeight");
  assertFinite(scrollTop, "scrollTop");
  const start = Math.min(totalRows, Math.max(0, Math.floor(scrollTop)));
  return { start, end: Math.min(totalRows, start + viewportHeight) };
}

export function clampScroll(totalRows: number, viewportHeight: number, scrollTop: number): number {
  assertCount(totalRows, "totalRows");
  assertCount(viewportHeight, "viewportHeight");
  assertFinite(scrollTop, "scrollTop");
  const maxScroll = Math.max(0, totalRows - viewportHeight);
  return Math.min(maxScroll, Math.max(0, Math.floor(scrollTop)));
}

/** 可变行高的只读布局模型：前缀和 + 二分查找，查找成本 O(log n) 与会话长度解耦。 */
export interface VariableLayout {
  readonly count: number;
  readonly totalHeight: number;
  heightAt(index: number): number;
  /** 第 index 行顶部相对内容起点的像素偏移；index === count 时返回 totalHeight。 */
  offsetOf(index: number): number;
  /** 返回顶部不晚于 offset 的最大行号，结果落在 [0, count]。 */
  indexOfOffset(offset: number): number;
}

export function createVariableLayout(
  count: number,
  heightOf: (index: number) => number,
): VariableLayout {
  assertCount(count, "count");
  const offsets = new Float64Array(count + 1);
  for (let index = 0; index < count; index += 1) {
    const height = heightOf(index);
    assertFinite(height, `heightOf(${index})`);
    if (height <= 0) throw new Error(`heightOf(${index}): expected a positive height`);
    offsets[index + 1] = offsets[index]! + height;
  }
  const totalHeight = offsets[count]!;
  return {
    count,
    totalHeight,
    heightAt(index) {
      assertCount(index, "index");
      if (index >= count) throw new Error(`index: expected < ${count}`);
      return offsets[index + 1]! - offsets[index]!;
    },
    offsetOf(index) {
      assertCount(index, "index");
      if (index > count) throw new Error(`index: expected <= ${count}`);
      return offsets[index]!;
    },
    indexOfOffset(offset) {
      assertFinite(offset, "offset");
      let low = 0;
      let high = count;
      while (low < high) {
        const mid = (low + high + 1) >>> 1;
        if (offsets[mid]! <= offset) low = mid;
        else high = mid - 1;
      }
      return low;
    },
  };
}

export interface VisibleRange {
  readonly start: number;
  readonly end: number;
  readonly offsetStart: number;
  readonly offsetEnd: number;
  readonly totalHeight: number;
}

/** 可见行区间；多带一行边界行作为安全余量，overscan 只在前后各扩若干行。 */
export function visibleRange(
  layout: VariableLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan = 0,
): VisibleRange {
  assertFinite(scrollTop, "scrollTop");
  assertCount(viewportHeight, "viewportHeight");
  assertCount(overscan, "overscan");
  const top = Math.max(0, scrollTop);
  const baseStart = layout.indexOfOffset(top);
  const baseEnd = layout.indexOfOffset(top + viewportHeight) + 1;
  const start = Math.max(0, baseStart - overscan);
  const end = Math.min(layout.count, baseEnd + overscan);
  return {
    start,
    end,
    offsetStart: layout.offsetOf(start),
    offsetEnd: layout.offsetOf(end),
    totalHeight: layout.totalHeight,
  };
}

export interface ScrollAnchor {
  /** 稳定身份：时间线条目 id，而非数组下标。 */
  readonly key: string;
  /** 视口顶部相对锚点行顶部的偏移；流式内容增长时该值保持不变。 */
  readonly offsetWithin: number;
}

export function captureScrollAnchor(
  layout: VariableLayout,
  keys: readonly string[],
  scrollTop: number,
): ScrollAnchor | undefined {
  if (layout.count === 0 || keys.length < layout.count) return undefined;
  const index = Math.min(layout.count - 1, layout.indexOfOffset(scrollTop));
  return { key: keys[index]!, offsetWithin: scrollTop - layout.offsetOf(index) };
}

export function restoreScrollFromAnchor(
  layout: VariableLayout,
  keys: readonly string[],
  anchor: ScrollAnchor,
  viewportHeight: number,
  fallbackScrollTop = 0,
): number {
  assertFinite(anchor.offsetWithin, "anchor.offsetWithin");
  const index = keys.indexOf(anchor.key);
  if (index < 0 || index >= layout.count) {
    return Math.max(0, Math.min(Math.max(0, layout.totalHeight - viewportHeight), fallbackScrollTop));
  }
  return Math.max(0, layout.offsetOf(index) + anchor.offsetWithin);
}

export function isAtBottom(
  layout: VariableLayout,
  scrollTop: number,
  viewportHeight: number,
): boolean {
  assertFinite(scrollTop, "scrollTop");
  assertCount(viewportHeight, "viewportHeight");
  return scrollTop >= Math.max(0, layout.totalHeight - viewportHeight) - 0.5;
}
