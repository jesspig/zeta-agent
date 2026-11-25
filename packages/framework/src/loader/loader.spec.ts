import { describe, expect, test } from "bun:test";
import type { Entry } from "@zeta-agent/loader";
import { createContext, defineComponent, defineKey, type Context } from "../context";
import { createLoader, type LoaderProfile, type RealmMigration } from "./loader";

function profile(entries: readonly Entry[], declarations: readonly ReturnType<typeof named>[] = []): LoaderProfile {
  return {
    layers: [{ kind: "bundle", source: "test", ops: entries.map((entry) => ({ op: "set", entry })) }],
    declarations,
  };
}

function named(name: string, events: string[]) {
  return defineComponent({
    name,
    inject: [],
    provide: [],
    apply: () => {
      events.push(`apply:${name}`);
      return () => {
        events.push(`dispose:${name}`);
      };
    },
  });
}

describe("T-05 framework facade createLoader", () => {
  test("稳定公开入口 load(profile) 真实装配并生效 config", async () => {
    const ctx = createContext();
    const loader = createLoader(ctx);
    const configs: unknown[] = [];
    const component = defineComponent({
      name: "./a.ts",
      inject: [],
      provide: [],
      apply: (_fiber, config) => {
        configs.push(config);
        return () => {};
      },
    });
    const result = await loader.load(profile([{ id: "a", name: "./a.ts", config: { v: 1 } }], [component]));
    expect(result.entries).toEqual(["a"]);
    expect(result.actions.map((item) => item.kind)).toEqual(["insert"]);
    expect(configs).toEqual([{ v: 1 }]);
    expect(loader.fiberOf("a")?.state.kind).toBe("ACTIVE");
    await loader.close();
    await ctx.dispose();
  });

  test("name 变化等待旧 fiber 去活后才 insert 新组件", async () => {
    const ctx = createContext();
    const loader = createLoader(ctx);
    const events: string[] = [];
    const old = named("./old.ts", events);
    const next = named("./next.ts", events);
    await loader.load(profile([{ id: "a", name: "./old.ts" }], [old, next]));
    const second = await loader.load(profile([{ id: "a", name: "./next.ts" }], [old, next]));
    expect(second.actions.map((item) => item.kind)).toEqual(["unload", "insert"]);
    expect(events.indexOf("dispose:./old.ts")).toBeLessThan(events.indexOf("apply:./next.ts"));
    expect(loader.state.entries.get("a")?.name).toBe("./next.ts");
    await loader.close();
    await ctx.dispose();
  });

  test("group 递归 keyed diff：子项用父:子 key，增删只影响对应子项", async () => {
    const ctx = createContext();
    const loader = createLoader(ctx);
    const events: string[] = [];
    const home = named("./home.ts", events);
    const admin = named("./admin.ts", events);
    const extra = named("./extra.ts", events);
    const group: Entry = {
      id: "nav",
      name: "@zeta/group",
      group: true,
      config: [
        { id: "home", name: "./home.ts" },
        { id: "admin", name: "./admin.ts" },
      ],
    };
    const first = await loader.load(profile([group], [home, admin, extra]));
    expect(first.entries).toEqual(["nav:home", "nav:admin"]);
    const withExtra: Entry = {
      ...group,
      config: [...(group.config as Entry[]), { id: "extra", name: "./extra.ts" }],
    };
    const added = await loader.load(profile([withExtra], [home, admin, extra]));
    expect(added.actions.map((item) => `${item.kind}:${item.entry.id}`)).toEqual(["insert:nav:extra"]);
    const reduced: Entry = {
      ...group,
      config: [{ id: "home", name: "./home.ts" }],
    };
    const removed = await loader.load(profile([reduced], [home, admin, extra]));
    expect(removed.actions.map((item) => `${item.kind}:${item.entry.id}`)).toEqual([
      "unload:nav:admin",
      "unload:nav:extra",
    ]);
    expect(removed.entries).toEqual(["nav:home"]);
    await loader.close();
    await ctx.dispose();
  });

  test("isolate 删除迁移所属 binding，不刷新无关 realm 的 fiber", async () => {
    const ctx = createContext();
    const migrations: RealmMigration[] = [];
    const loader = createLoader(ctx, { onRealmMigration: (migration) => migrations.push(migration) });
    const events: string[] = [];
    const a = named("./a.ts", events);
    const b = named("./b.ts", events);
    await loader.load(
      profile(
        [
          { id: "a", name: "./a.ts", isolate: { db: "shared" } },
          { id: "b", name: "./b.ts", isolate: { db: "shared" } },
        ],
        [a, b]
      )
    );
    const beforeB = loader.realmFor("b", "db");
    const bApplies = events.filter((item) => item === "apply:./b.ts").length;
    const result = await loader.load(
      profile(
        [
          { id: "a", name: "./a.ts", isolate: {} },
          { id: "b", name: "./b.ts", isolate: { db: "shared" } },
        ],
        [a, b]
      )
    );
    expect(result.actions.map((item) => item.kind)).toEqual(["realm"]);
    expect(migrations.some((item) => item.id === "a" && item.service === "db" && item.to === ctx.realm)).toBe(true);
    expect(loader.realmFor("b", "db")).toBe(beforeB);
    expect(events.filter((item) => item === "apply:./b.ts")).toHaveLength(bApplies);
    await loader.close();
    await ctx.dispose();
  });

  test("inject 经 key 解析器进入组件声明并被 apply 读到", async () => {
    const ctx: Context = createContext();
    const db = defineKey<unknown>("@zeta-agent/loader-test", "db");
    const loader = createLoader(ctx, {
      resolveKey: (service) => (service === "db" ? db : defineKey<unknown>(service, service)),
    });
    const seen: unknown[] = [];
    const component = defineComponent({
      name: "./a.ts",
      inject: [],
      provide: [],
      apply: (fiber) => {
        seen.push(fiber.get(db));
        return () => {};
      },
    });
    ctx.provide(db, "db-value");
    await ctx.notify();
    await loader.load(profile([{ id: "a", name: "./a.ts", inject: ["db"] }], [component]));
    expect(seen).toEqual(["db-value"]);
    await loader.close();
    await ctx.dispose();
  });

  test("update(config) 把新配置传入 apply，self-disable 回写后可恢复", async () => {
    const ctx = createContext();
    const loader = createLoader(ctx);
    const configs: unknown[] = [];
    const component = defineComponent({
      name: "./a.ts",
      inject: [],
      provide: [],
      apply: (_fiber, config) => {
        configs.push(config);
        return () => {};
      },
    });
    await loader.load(profile([{ id: "a", name: "./a.ts", config: { v: 1 } }], [component]));
    await loader.load(profile([{ id: "a", name: "./a.ts", config: { v: 2 } }], [component]));
    expect(configs).toEqual([{ v: 1 }, { v: 2 }]);

    const gated = (): LoaderProfile =>
      profile([{ id: "a", name: "./a.ts", disabled: { __jsExpr: "ready === false" } }], [component]);
    loader.setScope("ready", false);
    const disabled = await loader.load(gated());
    expect(disabled.actions.map((item) => item.kind)).toEqual(["unload"]);
    expect(disabled.disabled).toContain("a");
    loader.setScope("ready", true);
    const restored = await loader.load(gated());
    expect(restored.actions.map((item) => item.kind)).toEqual(["insert"]);
    expect(restored.disabled).toEqual([]);
    await loader.close();
    await ctx.dispose();
  });

  test("unsupported entry 在装配前显式拒绝", async () => {
    const ctx = createContext();
    const loader = createLoader(ctx);
    let error: unknown;
    try {
      await loader.load(profile([{ id: "a", name: "./missing.ts" }]));
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("UNSUPPORTED_ENTRY");
    await ctx.dispose();
  });
});
