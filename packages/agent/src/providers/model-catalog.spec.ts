import { describe, expect, test } from "bun:test";
import { decorateModels } from "./model-catalog";
import { MODELS_DEV_MODELS } from "./models-dev.generated";

describe("模型元数据装饰", () => {
  test("用 models.dev 元数据分列填充名称/上下文/价格/强度", () => {
    const key = Object.entries(MODELS_DEV_MODELS).find(
      ([, meta]) => meta.effort !== undefined && meta.cost !== undefined && meta.context > 0 && meta.cost.input > 0,
    )?.[0];
    expect(key).toBeDefined();
    const options = decorateModels([key!]);
    expect(options).toHaveLength(1);
    const option = options[0]!;
    expect(option.value).toBe(key!);
    expect(option.name.length).toBeGreaterThan(0);
    expect(option.context).toContain("K");
    expect(option.price).toContain("$");
    expect(option.effort.length).toBeGreaterThan(0);
  });

  test("未知模型给出最小可用选项", () => {
    const options = decorateModels(["totally-unknown-model-xyz"]);
    expect(options).toHaveLength(1);
    expect(options[0]?.value).toBe("totally-unknown-model-xyz");
    expect(options[0]?.group).toBe("Custom");
    expect(options[0]?.effort).toEqual([]);
  });

  test("大小写与版本点差异也能匹配官方元数据", () => {
    const options = decorateModels(["minimax-m3.1-flash", "glm-5.3-flash"]);
    // 中转商裸名应匹配到官方 MiniMax-M3.1-Flash（大小写 + 版本点不同）。
    expect(options[0]?.group).toBe("minimax");
    expect(options[0]?.context).toContain("K");
    expect(options[1]?.group).toBe("zhipuai");
    expect(options[1]?.price).toContain("$");
  });

  test("不同变体与不透明别名保持独立，不共用元数据", () => {
    const options = decorateModels([
      "glm-5.3-flash",
      "glm-5.3-flashx",
      "deepseek-v4.1-flash-1017",
      "deepseek-v4.1-flash",
    ]);
    // flash / flashx 是两个官方模型，各自命中各自元数据（价格不同），名字用 vendor id。
    expect(options[0]?.name).toBe("glm-5.3-flash");
    expect(options[1]?.name).toBe("glm-5.3-flashx");
    expect(options[0]?.group).toBe("zhipuai");
    expect(options[1]?.group).toBe("zhipuai");
    expect(options[0]?.price).not.toBe(options[1]?.price);
    // 两个不透明 canonical 别名保持独立：都解析到 deepseek 家族但价格/档位各自不同，
    // 且不会被中转商乱价覆盖（qzsqsfid 得到 maker 官方价）。
    expect(options[2]?.name).toBe("deepseek-v4.1-flash-1017");
    expect(options[3]?.name).toBe("deepseek-v4.1-flash");
    expect(options[2]?.name).not.toBe(options[3]?.name);
    expect(options[2]?.price).not.toBe("free"); // maker 官方价，非中转商 free
    expect(options[2]?.group).toBe("deepseek");
  });

  test("免费变体显示元数据且价格恒为 free", () => {
    const options = decorateModels(["beam-free", "hy4-flash-free", "longcat-2.5-free"]);
    // 免费变体应有上下文、推理/思考强度等元数据，价格固定为 free。
    expect(options[0]?.price).toBe("free");
    expect(options[0]?.context).toContain("K");
    expect(options[0]?.effort.length).toBeGreaterThan(0);
    expect(options[1]?.price).toBe("free");
    expect(options[1]?.effort.length).toBeGreaterThan(0);
    expect(options[2]?.price).toBe("free");
    expect(options[2]?.context).toContain("K");
  });

  test("保持 live id 顺序", () => {
    const options = decorateModels(["b-model", "a-model"]);
    expect(options.map((option) => option.value)).toEqual(["b-model", "a-model"]);
  });
});
