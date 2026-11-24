import { describe, expect, test } from "bun:test";
import { contextBudget } from "./hud";
import {
  createMetricsSampler,
  percentile,
  renderDebugHud,
  type RuntimeMetrics,
} from "./debug-hud";

describe("T-23 debug HUD runtime metrics", () => {
  test("percentile is deterministic and rejects invalid inputs", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([], 0.99)).toBe(0);
    expect(() => percentile([1, 2], 1.2)).toThrow();
    expect(() => percentile([1, Number.NaN], 0.99)).toThrow();
  });

  test("sampler keeps a bounded ring and reports event-loop/frame p99", () => {
    const sampler = createMetricsSampler({ capacity: 4 });
    for (let i = 0; i < 20; i += 1) {
      sampler.sample({
        eventLoopLagMs: i === 19 ? 90 : 1 + i,
        frameMs: i === 19 ? 80 : 2,
        cpuMs: 12 + i,
        rssBytes: 1024 * (20 + i),
      });
    }
    const metrics: RuntimeMetrics = sampler.snapshot();
    expect(metrics.samples).toBe(4);
    expect(metrics.eventLoopLagP99Ms).toBe(90);
    expect(metrics.frameP99Ms).toBe(80);
    expect(metrics.cpuMs).toBe(31);
    expect(metrics.rssBytes).toBe(1024 * 39);
  });

  test("default providers produce finite numbers without a terminal", () => {
    const sampler = createMetricsSampler();
    sampler.sample({ frameMs: 3, eventLoopLagMs: 2 });
    const metrics = sampler.snapshot();
    for (const value of Object.values(metrics)) expect(Number.isFinite(value)).toBe(true);
  });

  test("ten-thousand samples do not grow the retained metric buffer", () => {
    const sampler = createMetricsSampler({ capacity: 64 });
    for (let i = 0; i < 10_000; i += 1) sampler.sample({ frameMs: i % 13, eventLoopLagMs: i % 7 });
    expect(sampler.snapshot().samples).toBe(64);
    expect(sampler.snapshot().frameP99Ms).toBeLessThanOrEqual(12);
  });

  test("debug HUD renders context plus event-loop/cpu/rss/p99 metrics", () => {
    const budget = contextBudget(4096, 8192);
    const metrics: RuntimeMetrics = {
      eventLoopLagP99Ms: 12.5,
      frameP99Ms: 8.25,
      cpuMs: 1234,
      rssBytes: 64 * 1024 * 1024,
      samples: 30,
    };
    const panel = renderDebugHud(budget, metrics);
    expect(panel).toContain("4096/8192");
    expect(panel).toContain("EVENT p99=12.5ms");
    expect(panel).toContain("FRAME p99=8.25ms");
    expect(panel).toContain("CPU 1234ms");
    expect(panel).toContain("RSS 64MB");
    expect(panel).toContain("N=30");
    expect(renderDebugHud(budget, metrics)).toBe(panel);
  });
});
