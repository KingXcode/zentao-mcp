# 禅道 MCP Server（Codex）

这是一个面向公司禅道的本地只读 MCP Server。目前提供：

- `list_projects`：查询项目列表
- `list_products`：查询当前 Token 可访问的产品及其 ID
- `get_product_bugs`：查询产品 Bug
- `get_bug_detail`：根据 Bug ID 查询完整详情，可选返回操作历史
- `get_execution_tasks`：查询迭代任务

默认按禅道 RESTful API v1 编写，地址为：

```text
http://10.10.11.163:8080/api.php/v1
```

## 1. 准备 Token

使用专用、只读的禅道机器人账号获取 Token：

```bash
curl -X POST \
  "http://10.10.11.163:8080/api.php/v1/tokens" \
  -H "Content-Type: application/json" \
  -d '{"account":"codex-bot","password":"机器人账号密码"}'
```

不要把个人账号、密码或 Token 提交到 Git。

## 2. 安装

```bash
cd "/Users/nsy/Documents/Codex/2026-07-16/ru-gu/outputs/zentao-mcp"
npm install
cp .env.example .env
chmod 600 .env
chmod +x start.sh
```

编辑 `.env`，填写真正的 Token：

```dotenv
ZENTAO_BASE_URL=http://10.10.11.163:8080
ZENTAO_API_PREFIX=/api.php/v1
ZENTAO_TOKEN=你的Token
ZENTAO_TIMEOUT_MS=15000
```

## 3. 注册到 Codex

```bash
codex mcp add zentao -- \
  "/Users/nsy/Documents/Codex/2026-07-16/ru-gu/outputs/zentao-mcp/start.sh"
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

### 返回 401

Token 无效、过期，或者请求没有携带 Token。

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
- 第一阶段只授予读取权限。
- `.env` 权限设置为 `600`。
- 定期轮换 Token。
- 不要让工具接受任意 URL 或任意 API 路径。
- 后续增加创建或修改类工具时，必须要求人工确认。
