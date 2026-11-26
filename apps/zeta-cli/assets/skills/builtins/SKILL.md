---
name: builtins
description: 本地单文件内置的 builtin 工具技能索引（由 ResourceRegistry 消费）
---

# builtins

本技能列出 local-safe / local-full 档位下真实可用的 builtin 工具：

- 文件读取：`read`、`ls`、`grep`、`find`（local-safe 默认可用）
- 文件写入：`write`、`edit`（local-safe 默认可用）
- 真实 shell：`bash`、`powershell`（仅 local-full 显式启用）

工具是否进入模型 schema 由能力诊断决定：unsupported 的 shell 工具不会伪装成 active。
