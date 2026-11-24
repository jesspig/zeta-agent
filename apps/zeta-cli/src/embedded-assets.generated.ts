// 由 scripts/build-local.ts 按构建 target 生成；源码模式下使用当前宿主默认值。
// 自指二进制哈希不写入嵌入 manifest；发布目录的 manifest.json 才记录它。
import archMarker from "../assets/arch-marker.zetaasset" with { type: "file" };
import resourceCatalog from "../assets/resource-catalog.zetaasset" with { type: "file" };
import type { ArtifactManifest } from "@zeta-agent/deploy";

export const EMBEDDED_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  "arch-marker": archMarker,
  "resource-catalog": resourceCatalog,
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
      "bytes": 385,
      "sha256": "10125f6a77a890ae26c65c0dc93fd382f30300171194ed983c94452c9ae6fb4d"
    }
  ],
};
