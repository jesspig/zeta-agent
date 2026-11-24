import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDeferredTelemetry, withFirstFrame } from "./deferred-telemetry";

const sourceDir = join(import.meta.dir);

describe("T-20 首帧不等待 telemetry", () => {
  test("load 只在 start 后执行，且只执行一次", async () => {
    let calls = 0;
    const telemetry = createDeferredTelemetry(async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(telemetry.started).toBe(false);
    const first = telemetry.start();
    const second = telemetry.start();
    expect(telemetry.started).toBe(true);
    await Promise.all([first, second]);
    await telemetry.done;
    expect(calls).toBe(1);
  });

  test("加载失败通过 done 暴露，但不阻塞首帧", async () => {
    const telemetry = createDeferredTelemetry(async () => {
      throw new Error("OTLP_DOWN");
    });
    let firstFrame = false;
    await withFirstFrame({
      render: async () => {
        firstFrame = true;
        return "frame";
      },
      afterFirstFrame: () => telemetry.start(),
    });
    expect(firstFrame).toBe(true);
    await expect(telemetry.done).rejects.toThrow("OTLP_DOWN");
  });

  test("withFirstFrame 在 render 完成前不启动遥测加载", async () => {
    let resolver: (() => void) | undefined;
    let loaded = false;
    const frame = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    const pending = withFirstFrame({
      render: () => frame,
      afterFirstFrame: async () => {
        loaded = true;
      },
    });
    await Promise.resolve();
    expect(loaded).toBe(false);
    resolver?.();
    await pending;
    expect(loaded).toBe(true);
  });

  test("入口源码没有顶层 sentry/OTLP 静态 import，重模块走动态导入", () => {
    const entry = readFileSync(join(sourceDir, "index.ts"), "utf8");
    expect(entry).not.toMatch(/^\s*import\s+.*(?:sentry|opentelemetry|otlp)/im);
    const heavy = readFileSync(join(sourceDir, "telemetry-heavy.ts"), "utf8");
    expect(heavy).toContain("await import(");
  });
});
