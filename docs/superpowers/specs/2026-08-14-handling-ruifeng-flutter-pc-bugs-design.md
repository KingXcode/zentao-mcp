# 瑞丰 Flutter-PC 禅道 Bug Skill 设计

## 目标

创建个人 Skill `handling-ruifeng-flutter-pc-bugs`，为瑞丰Flutter-PC 项目提供稳定的只读 Bug 工作流：查询本人或指定同事需要处理的 Bug，展示可点击禅道链接，读取 Bug 正文、操作历史及其中的图片，并由用户选择下一步。

默认项目固定为：

- 项目名称：瑞丰Flutter-PC
- 禅道项目 ID：`502`
- Skill 安装位置：`/Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs`

本设计同时扩展当前 `zentao-mcp` 的只读工具，使 Skill 不直接读取 `.env`、不复制认证实现，也不通过临时脚本绕过 MCP。

## 成功标准

- 默认准确列出项目 `502` 中指派给当前账号且状态为 `active` 或 `confirmed` 的全部 Bug。
- 可按用户要求查询王昆、朱颂明/朱颂民、陈建华和陈智文的相同范围 Bug。
- 每条列表结果包含 ID、标题、状态、优先级、严重程度、指派人、截止时间和可点击禅道链接。
- 根据 Bug ID 返回完整详情、操作历史和图片清单，并能实际读取正文、附件或评论中的图片。
- 获取信息后停止，只有用户明确要求分析或解决时才检查源码仓库。
- 不修改真实禅道数据，不泄露 Token、账号或密码。

## Skill 触发和交互

Skill 应覆盖以下表达及同义请求：

- 查看我需要解决的禅道 Bug。
- 列出瑞丰Flutter-PC 的 Bug。
- 查看王昆、朱颂明、朱颂民、陈建华或陈智文的 Bug。
- 查看某个 Bug ID 的内容或图片。
- 分析、解决或修复某个瑞丰Flutter-PC Bug。

默认工作流：

1. 未指定人员时，通过禅道 `/user` 动态识别当前登录账号。
2. 查询项目 `502` 中状态为 `active` 或 `confirmed` 的全部匹配 Bug，不截断分页。
3. 按人员分组展示 Bug；每项提供可点击页面链接。
4. 询问用户需要查看或处理哪个 Bug ID。
5. 收到 ID 后读取并展示详情、操作历史及所有可用图片。
6. 停止在信息展示阶段，询问是否需要分析并解决。
7. 仅在用户明确使用“分析”“解决”“修复”等指令后进入源码阶段。

信息展示请求不得触发代码搜索、方案分析、分支创建、文件修改、测试或提交。

## 人员和状态口径

人员映射：

| 用户输入 | 禅道账号 | 系统姓名 |
|---|---|---|
| 当前用户、我 | 通过 `/user` 动态获取 | 通过 `/user` 动态获取 |
| 王昆 | `wangk` | 王昆 |
| 朱颂明、朱颂民 | `zhusongming` | 朱颂民 |
| 陈建华 | `chenjh` | 陈建华 |
| 陈智文 | `czw` | 陈智文 |

“需要解决”的默认状态仅包含：

- `active`
- `confirmed`

默认排除 `resolved`、`closed`、`delay` 和 `postponed`。如果用户明确要求其他状态，再按其请求扩大范围。

## MCP 架构

### `list_project_bugs`

新增只读工具，用固定项目 ID 或调用方提供的项目 ID 查询 Bug。

输入：

- `projectId`：正整数；Skill 默认传 `502`。
- `assigneeAccounts`：可选账号数组；为空时不按指派人过滤。
- `statuses`：可选状态数组；Skill 默认传 `active` 和 `confirmed`。

行为：

- 调用 `/projects/{projectId}/bugs`。
- 自动遍历全部分页并设置合理页数上限，避免只返回第一页或无限循环。
- 按账号字段过滤，不依赖列表接口是否带真实姓名。
- 返回项目总量、匹配数量及 Bug 摘要。
- 使用运行时配置的 `ZENTAO_BASE_URL` 生成页面链接，不在 Skill 中硬编码服务器地址。

每条摘要返回：

- `id`
- `title`
- `status`
- `priority`
- `severity`
- `assignedTo`
- `deadline`
- `webUrl`

### 增强 `get_bug_detail`

保留现有字段，并增加：

- `webUrl`：可点击禅道页面链接。
- 完整操作历史的文本内容。
- `images`：从 Bug 正文、普通附件和操作历史评论提取的图片元数据。

图片元数据至少包括：

- `fileId`
- `source`：`steps`、`file` 或 `action`
- `actionId`：仅评论图片需要
- `title` 或 `alt`

HTML 转纯文本与图片提取必须分开进行，避免 `plainText` 删除 `<img>` 后丢失文件 ID。

### `get_bug_image`

新增只读工具，输入 `bugId` 和 `fileId`：

1. 重新读取 Bug 详情并提取其全部图片元数据。
2. 验证 `fileId` 属于该 Bug；不允许把工具当成任意文件下载器。
3. 通过 Token 认证的 `/files/{fileId}` API 获取二进制内容。
4. 使用响应头和文件签名验证实际图片类型。
5. 在大小上限内以 MCP image content 返回；不输出 Token 或原始认证响应。

不支持的格式、过大内容、归属不匹配、HTTP 错误和正文读取失败均返回固定安全错误。

## 链接生成

Bug 页面链接由运行时 `ZENTAO_BASE_URL` 与 Bug ID 生成。实现使用禅道兼容页面地址，不将本机或公司地址写进 Skill：

```text
<ZENTAO_BASE_URL>/index.php?m=bug&f=view&bugID=<BUG_ID>
```

链接仅用于用户点击；API 查询仍使用 `ZENTAO_API_PREFIX`。

## 认证与安全边界

- 所有新工具复用现有 `createRuntimeClient`、自动登录、401 单次刷新和 Token 原子写回。
- Skill 不读取、不解析、不复制 `.env` 内容。
- MCP 输出继续经过最终出站脱敏边界。
- Bug 工具保持 `readOnlyHint: true`、`destructiveHint: false` 和幂等语义。
- 不新增修改、关闭、解决、指派或评论 Bug 的工具。
- 图片只写入 Codex 管理的临时位置或直接作为 MCP image content 使用；不保存进源码仓库。
- 错误不得包含 Token、账号、密码、认证请求或未经清理的底层响应。

## 源码仓库选择

只有用户明确要求分析或解决 Bug 时执行：

1. 使用 `git rev-parse --show-toplevel` 检查当前工作目录所属仓库。
2. 当前仓库是有效 `flutter-pc` Flutter 源码仓库时，使用当前仓库。
3. 否则在 `/Users/nsy` 下查找名称为 `flutter-pc` 的目录，并排除 `.git`、`node_modules`、构建产物、缓存和系统目录。
4. 只保留同时具有 Git 仓库和 `pubspec.yaml` 的候选目录。
5. 展示每个候选的绝对路径、当前分支和工作区状态。
6. 无论找到一个还是多个候选，都等待用户明确选择。
7. 用户选择前不分析代码、不创建或切换分支、不修改文件。

仓库确定后，后续分析、实现、测试和提交继续遵循当时适用的项目规则和开发 Skills；本 Skill 不复制通用开发流程。

## Skill 文件结构

```text
handling-ruifeng-flutter-pc-bugs/
├── SKILL.md
└── agents/
    └── openai.yaml
```

首版不放置认证脚本、固定服务器配置或图片资产。MCP 提供确定性数据能力，Skill 只保留工作流、项目 ID、人员别名、状态口径和交互边界。

## 错误处理

- MCP 未配置或未加载：说明如何检查 `zentao` MCP，并要求用户新开任务或重启客户端；不退回到读取 `.env`。
- 凭据缺失：沿用现有 Terminal 向导，保存后要求重新调用。
- 项目不可访问：返回项目 ID `502` 不存在或当前账号无权限的固定提示。
- 人员无匹配 Bug：明确返回 0，不自动扩大状态或人员范围。
- Bug ID 不属于项目：展示实际 Bug 信息前明确提醒，不把它误认为瑞丰Flutter-PC Bug。
- 图片不存在：说明正文、附件和评论中均未发现图片。
- 图片无法下载：仍展示 Bug 文本和图片元数据，并明确下载失败原因的安全分类。
- 源码目录未找到：报告搜索范围，等待用户提供路径，不猜测或创建仓库。

## 测试与验证

### MCP TDD

先添加失败测试，再实现最小行为：

- 多页项目 Bug 完整读取。
- 多指派人账号过滤。
- 默认可处理状态过滤与显式状态扩展。
- Bug 页面链接生成及基础地址尾斜杠处理。
- 从正文、附件和操作历史评论提取图片。
- 图片必须属于指定 Bug。
- PNG、JPEG、GIF、WebP 等签名和 MIME 一致性。
- 非图片、超限内容、404、401 与正文读取失败的固定错误。
- 新旧 Token、账号和密码不出现在成功或错误输出。
- 现有五个工具契约和认证行为不回归。

### Skill TDD

在创建 Skill 前，用无 Skill 的全新 Agent 运行基线场景并记录失败：

- 是否漏掉分页、链接或评论图片。
- 是否把“查看 Bug”误做成代码分析。
- 是否未经用户选择就自动使用或修改某个源码仓库。
- 是否不能识别“朱颂明”到系统“朱颂民”的别名。

创建 Skill 后用相同场景复测，确认输出形状和停止条件稳定。验证场景使用只读数据或合成 MCP 返回，不修改真实禅道和 Flutter 源码。

### 完成验证

- 运行 MCP 聚焦测试、全量测试、Node/Shell 语法检查和 `git diff --check`。
- 使用 Bug `22530` 的评论图片做一次获授权的只读集成验证。
- 使用 Skill Creator 的 `quick_validate.py` 验证 Skill 目录。
- 检查 `agents/openai.yaml` 与 SKILL.md 一致。
- 独立审查安全边界、工作流停止点和源码仓库选择规则。

## 非目标

- 不通过 MCP 修改任何禅道 Bug。
- 不自动接受、关闭、解决、指派或评论 Bug。
- 不在仅查看信息时分析代码或提出修复方案。
- 不自动选择非当前源码仓库。
- 不把账号、密码、Token、服务器地址或图片复制进 Skill。
- 不为其他禅道项目建立通用项目管理框架。
