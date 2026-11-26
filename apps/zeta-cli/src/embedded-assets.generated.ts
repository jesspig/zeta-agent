// 由 scripts/build-local.ts 按构建 target 生成；源码模式下使用当前宿主默认值。
// 自指二进制哈希不写入嵌入 manifest；发布目录的 manifest.json 才记录它。
import archMarker from "../assets/arch-marker.zetaasset" with { type: "file" };
import resourceCatalog from "../assets/resource-catalog.zetaasset" with { type: "file" };
import systemPrompt from "../assets/prompts/system.md" with { type: "file" };
import skillsIndex from "../assets/skills/builtins/SKILL.md" with { type: "file" };
import configSchema from "../assets/schema/config.zetaasset" with { type: "file" };
import type { ArtifactManifest } from "@zeta-agent/deploy";

export const EMBEDDED_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  "arch-marker": archMarker,
  "resource-catalog": resourceCatalog,
  "system-prompt": systemPrompt,
  "skills-index": skillsIndex,
  "config-schema": configSchema,
});

export const EMBEDDED_MANIFEST: ArtifactManifest = {
  version: 1,
  target: "win32-x64",
  binary: { arch: "x64", path: "zeta-win32-x64.exe", bytes: 0 },
  embedded: [
    {
      "id": "arch-marker",
      "kind": "data",
      "arch": "universal",
      "path": "arch-marker.zetaasset",
      "bytes": 128,
      "sha256": "5ba2602c95a239da9c9696f5e6d01ecf0711b36db8ccf81defda368eec7fdaf9"
    },
    {
      "id": "resource-catalog",
      "kind": "data",
      "arch": "universal",
      "path": "resource-catalog.zetaasset",
      "bytes": 843,
      "sha256": "22d470034af330e0ee9333541e40956d841ec3de865040597d1f5ffade5123d0"
    },
    {
      "id": "system-prompt",
      "kind": "data",
      "arch": "universal",
      "path": "prompts/system.md",
      "bytes": 630,
      "sha256": "453cbacc323af55eb3afa3567bf4c65409de171c7f6bc0c6948e276b1d85e6d9"
    },
    {
      "id": "skills-index",
      "kind": "data",
      "arch": "universal",
      "path": "skills/builtins/SKILL.md",
      "bytes": 542,
      "sha256": "96014f15fb91a360d3c3774865babc1a4633f21addc85425f4d67c558899a1c9"
    },
    {
      "id": "config-schema",
      "kind": "data",
      "arch": "universal",
      "path": "schema/config.zetaasset",
      "bytes": 482,
      "sha256": "c25c56f6e378059ee4bfb4a602df570a8b393afae4a3ebaf61154dd4a3b84a24"
    }
  ],
};
