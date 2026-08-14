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
chmod +x start.sh stop.sh
```

只需确认项目目录 `.env` 中的服务器地址正确；MCP 进程不会读取其他路径的环境文件。首次配置可将 Token、账号和密码全部留空：

```dotenv
ZENTAO_BASE_URL=http://10.10.11.204
ZENTAO_API_PREFIX=/api.php/v1
ZENTAO_TOKEN=
ZENTAO_ACCOUNT=
ZENTAO_ACCOUNT_ENCODING=
ZENTAO_PASSWORD=
ZENTAO_PASSWORD_ENCODING=
ZENTAO_TIMEOUT_MS=15000
```

首次调用工具且需要登录时，MCP 会自动打开一个新的 macOS Terminal 窗口：

1. 输入禅道账号；账号会正常显示。
2. 输入并再次确认密码；两次密码均不回显，也不显示星号。
3. 保存成功后返回 Codex，重新调用刚才的工具；不需要重启 MCP。

向导会把账号和密码原子写入项目 `.env`，并将文件权限保持为 `0600`。同一轮凭据缺失状态只会成功打开一个窗口，多个并发工具调用不会反复弹窗。密码为空或两次不一致时会要求重试，最多三次；失败时不修改 `.env`。

有效的 `ZENTAO_TOKEN` 会直接用于查询，不会打开向导。Token 缺失，或业务 GET 请求收到 HTTP 401 时，本地 MCP 进程会重新读取 `.env` 并自动登录；取得的新 Token 会原子写回 `.env`，然后仅重试原请求一次。第二次仍为 401 时会直接返回错误，不会循环登录或重试。

账号和密码只在独立 Terminal 的 TTY 中输入，并由本机进程写入 `.env`；它们不是 MCP 工具参数，不进入 Codex 对话、MCP stdio、命令行参数或日志。向导使用 base64url 信封保存凭据，以便引号、换行和 Unicode 等字符精确往返；这只是可逆编码，不是加密。不要把个人账号、密码或 Token 提交到 Git。

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

## 3. 手动停止与重启

停止本项目全部 MCP 实例：

```bash
./stop.sh
```

重启：

```bash
./stop.sh
./start.sh
```

`stop.sh` 只向本项目的 `server.mjs` 进程发送 `TERM`；没有运行实例时可安全重复执行。

## 4. 使用示例

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

## 5. 常见问题

### 没有自动打开凭据配置终端

自动打开目前只支持 macOS。可以双击项目中的 `scripts/configure-credentials.command`，或在一个独立终端中运行：

```bash
./scripts/configure-credentials.command
```

填写并保存后，回到 Codex 重新调用原工具。若系统报告没有执行权限，运行 `chmod +x scripts/configure-credentials.command`。非 macOS 平台不会尝试其他桌面命令，但仍可从支持 `sh` 和 Node.js 的交互式终端手动运行这个固定启动器。

### 自动登录失败：账号或密码错误

再次运行固定凭据向导并输入专用只读机器人账号的正确凭据。保存后无需重启 MCP，直接重新调用工具即可。有效 Token 时账号密码可以留空；Token 缺失或收到 401 且凭据为空时会提示“已打开禅道凭据配置终端；填写并保存后请重新调用”。

### 自动登录失败：响应异常

确认 `ZENTAO_BASE_URL` 与 `ZENTAO_API_PREFIX` 指向正确的禅道 API。登录超时会返回“禅道自动登录失败：请求超时”；网络请求失败、非成功 HTTP 状态、响应不是 JSON 或响应缺少有效 token 都会返回相应的“禅道自动登录失败”错误，且不会包含账号、密码或 Token。

### 自动登录失败：`.env` 不可写

凭据向导和自动登录拿到的新 Token 都需要原子更新项目 `.env`。确认该文件及其所在目录对本机用户可写，再执行 `chmod 600 .env`；凭据不能写入时向导不会显示保存成功，Token 不能写入时会返回“禅道 Token 持久化失败”，原查询不会重试。

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
- base64url 凭据信封不是加密；本机文件权限仍是主要保护边界。
- 定期轮换 Token。
- 不要让工具接受任意 URL 或任意 API 路径。
- 后续增加创建或修改类工具时，必须要求人工确认。
