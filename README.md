# 禅道 MCP Server（Codex）

这是一个面向公司禅道的本地只读 MCP Server。目前提供：

- `list_projects`：查询项目列表
- `list_products`：查询当前 Token 可访问的产品及其 ID
- `get_product_bugs`：查询产品 Bug
- `get_bug_detail`：根据 Bug ID 查询完整详情，可选返回操作历史
- `get_execution_tasks`：查询迭代任务

默认按禅道 RESTful API v1 编写。

## 1. 安装和认证

```bash
cd /path/to/zentao-mcp
npm install
cp .env.example .env
chmod 600 .env
chmod +x start.sh
```

只编辑项目目录中的 `.env`；MCP 进程不会读取其他路径的环境文件。首次配置可将 `ZENTAO_TOKEN` 留空，填写专用只读机器人账号和密码：

```dotenv
ZENTAO_BASE_URL=http://10.10.11.204
ZENTAO_API_PREFIX=/api.php/v1
ZENTAO_TOKEN=
ZENTAO_ACCOUNT=codex-bot
ZENTAO_PASSWORD=请替换为机器人账号密码
ZENTAO_TIMEOUT_MS=15000
```

有效的 `ZENTAO_TOKEN` 会直接用于查询，此时 `ZENTAO_ACCOUNT` 和 `ZENTAO_PASSWORD` 可以留空。Token 缺失，或业务 GET 请求收到 HTTP 401 时，本地 MCP 进程会自动登录；取得的新 Token 会原子写回项目 `.env`、将其权限保持为 `0600`，然后仅重试原请求一次。第二次仍为 401 时会直接返回错误，不会循环登录或重试。

账号和密码只由本机 MCP 进程从 `.env` 读取；它们不是 MCP 工具参数，也不会返回给 AI。不要把个人账号、密码或 Token 提交到 Git。

## 2. 注册到 Codex

```bash
codex mcp add zentao -- \
  "/absolute/path/to/zentao-mcp/start.sh"
```

确认配置：

```bash
codex mcp list
codex mcp get zentao
```

如果之前已经添加：

```bash
codex mcp remove zentao
```

然后重新执行添加命令。

## 3. 使用示例

重新打开一个 Codex 任务，输入：

```text
列出我有权限查看的禅道项目。
```

或者：

```text
查询禅道产品 1 中尚未关闭的 Bug，按负责人分组，标出高优先级问题。
```

```text
读取禅道 Bug 20836 的完整详情，分析重现步骤、环境和可能涉及的代码模块。
```

```text
查询禅道迭代 258 中尚未完成的任务，按负责人汇总剩余工作量。
```

## 4. 常见问题

### 自动登录失败：账号或密码错误

检查项目 `.env` 中的 `ZENTAO_ACCOUNT` 和 `ZENTAO_PASSWORD` 是否为专用机器人账号的正确值。有效 Token 时这两个字段可留空；Token 缺失或收到 401 后，缺少任一字段会返回“禅道 Token 不可用，且缺少 ZENTAO_ACCOUNT 或 ZENTAO_PASSWORD”。

### 自动登录失败：响应异常

确认 `ZENTAO_BASE_URL` 与 `ZENTAO_API_PREFIX` 指向正确的禅道 API。登录超时会返回“禅道自动登录失败：请求超时”；网络请求失败、非成功 HTTP 状态、响应不是 JSON 或响应缺少有效 token 都会返回相应的“禅道自动登录失败”错误，且不会包含账号、密码或 Token。

### 自动登录失败：`.env` 不可写

自动登录拿到新 Token 后需要原子更新项目 `.env`。确认该文件及其所在目录对运行 MCP 的本机用户可写，再执行 `chmod 600 .env`；不能写入时会返回“禅道 Token 持久化失败”，原查询不会重试。

### 返回 403

机器人账号没有对应项目、产品或迭代的查看权限。

### 返回 `not found`

确认实际使用的是 API v1，并检查接口路径。Bug 列表接口使用 `browseType`、`pageID` 和 `recPerPage`；“指派给我”的筛选值是 `assignedtome`。

### Codex 中看不到工具

执行：

```bash
codex mcp get zentao
```

确认启动脚本路径正确，并在添加 MCP 后重新打开 Codex 任务。

## 安全建议

- 使用专用机器人账号。
- 机器人账号只授予读取权限。
- `.env` 必须设置为 `600`。
- 定期轮换 Token。
- 不要让工具接受任意 URL 或任意 API 路径。
- 后续增加创建或修改类工具时，必须要求人工确认。
