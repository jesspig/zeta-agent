import { describe, expect, test } from "bun:test";
import { toPaletteCommands, type CommandSpecView } from "./command-palette";

function spec(name: string, description: string, category: string): CommandSpecView {
  return { name, description, category };
}

describe("T-14 命令注册表 ⇄ 命令面板联动", () => {
  test("toPaletteCommands 把命令规格映射为面板条目（id=name, title=description）", () => {
    const items = toPaletteCommands([
      spec("model", "切换模型", "model"),
      spec("tree", "显示会话树", "session"),
    ]);
    expect(items).toEqual([
      { id: "model", title: "切换模型" },
      { id: "tree", title: "显示会话树" },
    ]);
  });

  test("扩展自定义命令同样出现在面板条目中", () => {
    const items = toPaletteCommands([
      spec("model", "切换模型", "model"),
      spec("deploy", "部署", "custom"),
    ]);
    expect(items.map((item) => item.id)).toContain("deploy");
  });

  test("空输入返回空列表", () => {
    expect(toPaletteCommands([])).toEqual([]);
  });
});
