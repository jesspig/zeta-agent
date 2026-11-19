import { describe, expect, test } from "bun:test";
import { computeConfigDigest, start, type DeployConfig, type DeployMode } from "./deployment";

const baseConfig: DeployConfig = { target: "linux-x64", port: 4100, label: "primary" };

describe("T-28 three-state deployment handle", () => {
  test("start supports local, daemon and remote modes", () => {
    const modes: DeployMode[] = ["local", "daemon", "remote"];
    for (const mode of modes) {
      const handle = start(mode, baseConfig);
      expect(handle.mode).toBe(mode);
      expect(typeof handle.readiness).toBe("function");
      expect(typeof handle.liveness).toBe("function");
      expect(typeof handle.configDigest).toBe("function");
      handle.stop();
    }
  });

  test("readiness and liveness probes reflect lifecycle transitions", () => {
    const local = start("local", baseConfig);
    expect(local.liveness()).toBe(true);
    expect(local.readiness()).toBe(true);

    const daemon = start("daemon", baseConfig);
    expect(daemon.liveness()).toBe(true);
    expect(daemon.readiness()).toBe(false);
    daemon.setReadiness(true);
    expect(daemon.readiness()).toBe(true);
    daemon.stop();
    expect(daemon.liveness()).toBe(false);
    expect(daemon.readiness()).toBe(false);

    const remote = start("remote", baseConfig);
    expect(remote.liveness()).toBe(true);
    expect(remote.readiness()).toBe(false);
    remote.setReadiness(true);
    expect(remote.readiness()).toBe(true);
    remote.stop();
  });

  test("start rejects an illegal target", () => {
    expect(() => start("local", { target: "plan9-x64" })).toThrow(/target/i);
  });

  test("config digest is stable and changes when config changes", () => {
    const handle = start("local", baseConfig);
    const first = handle.configDigest();
    expect(handle.configDigest()).toBe(first);

    handle.updateConfig({ ...baseConfig, label: "secondary" });
    const second = handle.configDigest();
    expect(second).not.toBe(first);

    handle.updateConfig({ ...baseConfig, label: "secondary" });
    expect(handle.configDigest()).toBe(second);
  });

  test("config digest is a pure deterministic function independent of key order", () => {
    expect(computeConfigDigest(baseConfig)).toBe(computeConfigDigest({ ...baseConfig }));
    expect(computeConfigDigest({ a: 1, b: 2 })).toBe(computeConfigDigest({ b: 2, a: 1 }));
    expect(computeConfigDigest({ a: 1 })).not.toBe(computeConfigDigest({ a: 2 }));
  });
});
