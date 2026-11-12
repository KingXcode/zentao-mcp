# Agent 安装工具

这是随项目提供的本地网页工具，用于把禅道 MCP 注册到常见 Agent，或移除注册。

## 启动

需要 Node.js 20 或更新版本，以及首次安装 npm 依赖所需的网络。请先安装需要使用的 Agent。

```bash
git clone https://github.com/KingXcode/zentao-mcp.git
cd zentao-mcp
node scripts/manage-agents.mjs
```

macOS 也可以双击根目录 `manage.command`，Windows 双击 `manage.cmd`。Linux 可以运行 `sh manage.command`。若 macOS 下载 ZIP 后丢失执行权限，先运行 `chmod +x manage.command`。

依赖缺失时，启动器自动执行 `npm ci --omit=dev`。依赖就绪后会在本机随机端口启动网页并自动打开浏览器。也可运行：

```bash
npm run mcp:manage
# 不自动打开浏览器，或固定网页端口
npm run mcp:manage -- --no-open --port 8765
```

保留启动窗口。完成后点击网页右上角「关闭工具」，或者在启动窗口按 Ctrl+C。

## 在网页操作

1. 在「禅道连接」填写服务器地址。首次配置时可展开账号密码表单；全部留空会保留已有凭据或 Token。
2. 点击「保存连接」。账号、密码仅保存在本项目 `.env`，沿用项目的 base64url 凭据编码；它是可逆编码，文件需要妥善保管。页面和 Agent 配置不会回显凭据。更换地址或账号时会清空旧 Token，后续查询自动重新登录。
3. 在 Agent 列表点击「安装」，或者勾选多个目标后点击「安装所选」。已有本项目注册时可直接卸载。
4. 重新启动对应 Agent；首次连接时按该 Agent 的界面提示确认信任。状态「已注册」表示配置已写入，实际连接和工具可用性请在 Agent 中查看。

安装会创建缺失的项目 `.env`，已有 `.env` 会保留。启动命令使用当前 Node 可执行文件和本项目 `server.mjs` 的绝对路径，支持含空格及中文的路径，也不依赖 Agent 的工作目录或 shell。移动项目目录或删除当前 Node 安装后，请在新位置重新注册。

卸载保留项目、依赖、`.env` 和其他 MCP。若要删除整个项目，请先在使用它的 Agent 中卸载注册，再自行处理项目目录。

## 支持的配置

默认修改当前用户的全局配置，不修改工作区配置。网页中可以展开每一行的「配置位置」查看实际路径。

| Agent ID | Agent | 默认配置文件 |
| --- | --- | --- |
| `codex` | Codex 桌面 / CLI / IDE 插件 | `~/.codex/config.toml`，支持 `CODEX_HOME` |
| `claude-code` | Claude Code | `~/.claude.json`，支持 `CLAUDE_CONFIG_DIR` 下的 `.claude.json` |
| `claude-desktop` | Claude Desktop | macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；Windows：`%APPDATA%\Claude\claude_desktop_config.json`；Linux：`$XDG_CONFIG_HOME/Claude/claude_desktop_config.json`，未设置时使用 `~/.config` |
| `cursor` | Cursor | `~/.cursor/mcp.json` |
| `windsurf` | Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| `vscode` | VS Code / GitHub Copilot | `~/.copilot/mcp-config.json`，支持 `COPILOT_HOME` |
| `vscode-local` | VS Code Local / 兼容配置 | macOS：`~/Library/Application Support/Code/User/mcp.json`；Windows：`%APPDATA%\Code\User\mcp.json`；Linux：`$XDG_CONFIG_HOME/Code/User/mcp.json`，未设置时使用 `~/.config` |
| `gemini` | Gemini CLI | `~/.gemini/settings.json` |

VS Code 的 `vscode` 项使用当前官方文档推荐的 Copilot 全局配置（`mcpServers`）；Local harness、旧版 VS Code 和使用原有用户配置的场景可选择 `vscode-local`（`servers`）。通常只需选择适用于自己环境的一项。自定义 VS Code Profile、便携版、WSL 或远程环境，请在实际运行 Agent 的环境中操作，或通过 `--config` 指定配置文件。

配置格式参考：[Codex MCP](https://developers.openai.com/codex/mcp/)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)、[Claude Desktop 本地 MCP](https://modelcontextprotocol.io/docs/develop/connect-local-servers)、[Cursor MCP](https://cursor.com/docs/context/mcp)、[Windsurf MCP](https://docs.windsurf.com/windsurf/cascade/mcp)、[VS Code MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers)、[Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/)。

## 命令行批量操作

```bash
# 状态查询
npm run mcp:status

# 安装、卸载指定 Agent；也可用 --agent all
npm run mcp:install -- --agent codex,cursor,claude-code
npm run mcp:uninstall -- --agent codex,cursor

# 先预览，不修改 Agent 配置或 .env
npm run mcp:install -- --agent all --dry-run

# 指定一个 Agent 的自定义配置
npm run mcp:manage -- install --agent cursor --config /absolute/path/mcp.json

# 在自定义主目录下管理配置，忽略 CODEX_HOME、APPDATA 等目录覆盖变量
npm run mcp:manage -- --home /absolute/path/profile
```

`--home` 只改变 Agent 配置的目标目录；项目 `.env` 仍位于本项目目录。首次启动预览命令时，启动器仍可能安装缺失的项目依赖。

## 备份与异常处理

- 每次实际修改已有配置前，原文保存到同目录的 `<原文件名>.zentao-mcp-<随机标识>.bak`；操作记录会给出位置。重复安装且无变化时不重复写入或备份。
- JSON/JSONC 和 TOML 通过解析后局部更新，保留其他设置、注释和换行格式。格式错误、重复字段或同名项属于其他项目时拒绝修改；批量操作全部预检通过后才开始写入。
- 写入使用临时文件和原子替换，符号链接配置会更新真实目标并保留链接。若多目标写入中途发生文件权限等错误，界面会保留此前已完成项的结果；可修复问题后重新操作。
- 若提示配置已被其他程序修改，刷新页面后重试。若上次异常退出留下 `.zentao-mcp.lock`，确认没有其他安装工具在运行后再删除该锁文件。
- 恢复备份前先关闭相关 Agent，并将需要的 `.bak` 内容复制回原配置文件。备份可能包含其他服务的个人配置，勿提交或分享。macOS/Linux 创建的配置与备份权限为 `0600`；Windows 使用当前用户目录的系统 ACL。
- 网页仅绑定 `127.0.0.1`，请求同时检查 Host、Origin 和每次启动生成的页面会话标记；不向外部站点提供访问权限。页面资源全部本地加载。

自动化测试覆盖各配置格式、平台路径、备份、并发变更、冲突、网页接口及真实 MCP 启动握手；各 Agent 的客户端界面、Windows/Linux 桌面及远程环境仍需要对应环境验收。
