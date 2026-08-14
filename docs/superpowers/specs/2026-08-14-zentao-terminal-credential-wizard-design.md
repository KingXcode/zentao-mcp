# 禅道终端凭据向导设计

## 目标

当 MCP 因 Token 缺失或失效而需要登录、但项目 `.env` 尚未配置账号密码时，自动打开一个独立的 macOS Terminal 窗口，引导用户输入禅道账号和密码。向导安全写入 `.env` 后，用户再次调用原 MCP 工具即可自动登录，无需预先查找或手动编辑 `.env`，也无需重启 MCP。

## 为什么必须使用独立终端

MCP Server 通过标准输入输出与 Codex 传输协议消息。直接在 MCP 进程当前 stdin 中读取账号密码会与协议输入竞争，并可能破坏连接。因此凭据采集必须运行在独立 Terminal 的 TTY 中；账号密码绝不作为 MCP 工具参数、子进程命令行参数或 Codex 对话内容传递。

## 用户流程

1. 用户调用任意需要禅道请求的 MCP 工具。
2. 有效 Token 继续直接使用，不打开终端。
3. Token 缺失或业务 GET 返回 HTTP 401 时，客户端进入自动登录流程。
4. 自动登录前重新读取项目 `.env` 中的账号密码。
5. 若账号或密码为空，MCP 启动独立 Terminal 凭据向导，并返回固定提示：“已打开禅道凭据配置终端；填写并保存后请重新调用。”
6. 独立终端依次提示禅道账号、密码和密码确认。账号可见；密码与确认输入均关闭回显。
7. 密码两次不一致时不写文件，提示后重新输入密码，最多三次；三次仍不一致则退出并保持 `.env` 不变。
8. 输入有效后，向导原子写入账号密码，将 `.env` 权限保持为 `0600`，显示成功提示，等待用户按回车关闭。
9. 用户再次调用 MCP 工具。客户端重新读取新凭据，登录、原子写回新 Token，并继续现有的一次重试流程。

## 自动打开行为

- 新增固定启动器 `scripts/configure-credentials.command`，由 macOS Terminal 执行。
- MCP 只调用系统 `/usr/bin/open -a Terminal <固定启动器绝对路径>`，不接受任何用户文件路径或任意命令。
- 启动器根据自身目录定位项目，并执行 `scripts/configure-credentials.mjs`；路径包含空格时仍安全。
- 账号和密码只在新 Terminal 的 TTY 内读取，不出现在 `open` 参数、进程环境、日志或错误消息中。
- 同一个 MCP 进程在凭据仍缺失期间最多成功打开一次窗口，避免多个并发请求重复弹窗。若系统打开命令失败，则允许下一次调用重试打开。
- 成功读取到非空账号密码后，打开状态重置；未来用户清空凭据时可再次打开。
- 非 macOS 平台不尝试执行其他桌面命令，返回清晰的“不支持自动打开终端”错误和固定启动器路径提示。

## 组件设计

### `lib/credential-wizard.mjs`

负责从 MCP 进程启动固定 Terminal 向导，并去重并发启动。对外提供：

```js
createCredentialWizardLauncher({ launcherPath, platform, spawnImpl })
  -> { open(): Promise<void>, markConfigured(): void }
```

生产环境固定传入项目启动器路径、`process.platform` 和 `child_process.spawn`；测试注入替身，不真正打开 GUI。

### `scripts/configure-credentials.command`

只定位脚本目录并 `exec node configure-credentials.mjs`。它不读取 `.env`、不处理密码，也不把账号密码拼接进 shell 命令。

### `scripts/configure-credentials.mjs`

确认 stdin/stdout 是 TTY，读取可见账号并使用 raw-mode 隐藏提示读取两次密码。Ctrl-C、异常和正常退出均恢复终端 echo/raw 状态。验证非空账号和密码、确认一致后调用凭据持久化模块。它不返回或打印凭据。

### `lib/env-credentials.mjs`

负责账号密码的编码和 `.env` 更新。对外提供：

```js
updateEnvCredentials(envPath, { account, password }): Promise<void>
```

它复用现有 `atomicReplaceFile()`，一次性更新账号、密码及两条编码元数据，保留其他配置、注释、缩进和 CRLF。四个字段要么一起提交，要么完全不改变目标文件。

### `lib/credential-env-codec.mjs`

账号密码使用独立的 base64url-v1 信封及伴随元数据：

```dotenv
ZENTAO_ACCOUNT="__ZENTAO_MCP_CREDENTIAL_V1__..."
ZENTAO_ACCOUNT_ENCODING=base64url-v1
ZENTAO_PASSWORD="__ZENTAO_MCP_CREDENTIAL_V1__..."
ZENTAO_PASSWORD_ENCODING=base64url-v1
```

该编码只为保证任意 Unicode、引号、空格、`#`、反斜杠、换行等字符能精确往返，不是加密。无编码元数据的现有明文账号密码继续兼容；有元数据但信封损坏时启动失败，错误不得包含凭据。

### `lib/runtime-config.mjs`

使用凭据 codec 解码账号密码。保留现有 Token codec、超时校验和基于指定 `.env` 的隔离加载。

### `lib/zentao-client.mjs`

认证配置从固定快照改为可重新加载：

```js
loadCredentials(): { account: string, password: string }
onCredentialsRequired(): Promise<void>
```

- `performLogin()` 每次开始时调用 `loadCredentials()`。
- 非空动态凭据加入实时秘密集合，继续受最终 MCP 出站脱敏保护。
- 缺失凭据时等待 `onCredentialsRequired()` 完成“启动终端”动作，然后抛固定提示错误；不等待用户输入，也不占用 MCP 请求。
- 默认实现仍可返回构造客户端时提供的静态账号密码，保持单元测试和内部调用兼容。
- 多个并发登录共享现有 `refreshPromise`，因此一次缺失状态只执行一次凭据检测和启动动作。

### `server.mjs`

创建固定向导 launcher，并向客户端注入：

- `loadCredentials`：每次从项目 `.env` 重新加载账号密码。
- `onCredentialsRequired`：打开固定 Terminal 启动器。

五个 MCP 工具名称、schema、只读注解、数据映射与正常返回结构保持不变。

## 文件更新语义

- `.env` 不存在或不可读时，向导不自行创建完整配置，因为服务器地址等必需值无法安全猜测；返回明确错误。
- 已存在字段时只替换第一个有效配置行，并保留其水平缩进和换行风格。
- 缺失字段按账号、账号编码、密码、密码编码的顺序追加。
- 重复运行向导不产生重复有效字段。
- 临时文件在写入、`chmod(0600)`、权限校验、sync 和 close 完成后才原子 rename；rename 后无可失败操作。

## 错误和安全边界

- 打开 Terminal 失败、非 macOS、非 TTY、输入为空、密码不一致、写入失败分别使用固定错误，不包含账号或密码。
- 密码输入不回显，也不显示星号，避免泄露长度。
- 任何异常路径恢复 TTY 状态。
- 固定 `.env` 和启动器路径来自 `import.meta.url`，MCP 工具不接收路径参数。
- 新增账号密码编码元数据仍受 `.gitignore` 和 `.env` 的 `0600` 保护。
- base64url 不是加密；README 必须继续强调专用只读机器人账号和本机文件权限。

## 测试策略

使用 Node 内置 `node:test`，全部桌面启动行为通过依赖注入测试，不在自动化测试中打开真实 Terminal。

覆盖：

- 有效 Token 不加载向导。
- Token 缺失、动态凭据为空时启动一次向导并返回固定重试提示。
- 多个并发请求只启动一次向导。
- 向导启动失败后下一次调用可重试。
- 用户保存凭据后，同一 MCP 进程下一次调用重新加载并自动登录。
- 固定 macOS `open -a Terminal` 参数，不允许任意路径。
- 非 macOS 固定失败。
- TTY 密码隐藏、确认不一致、Ctrl-C/raw-mode 恢复通过可注入输入状态机测试。
- 账号密码 codec 对 Unicode、引号、空格、`#`、反斜杠、LF、CR、U+FEFF 精确往返。
- 带元数据的损坏凭据信封安全失败；无元数据明文兼容。
- `.env` 四字段整体原子更新、CRLF/注释/缩进保留、`0600` 和重复运行不重复。
- 现有 77 项测试全部继续通过。

## 文档

- `.env.example` 保留可手动编辑的明文字段，并新增可选编码元数据说明；不放真实凭据。
- README 主流程改为无需预先填写账号密码：首次需要登录时自动打开 Terminal 向导。
- README 说明保存后重新调用、密码隐藏、macOS 限制、手动运行启动器的故障降级方式和 base64url 非加密性质。

## 成功标准

- 用户无需查找或直接编辑 `.env` 即可配置登录凭据。
- 凭据不进入 MCP stdio、Codex 对话、命令行参数、进程环境或日志。
- 保存后无需重启 MCP，下一次工具调用即可加载凭据并自动登录。
- 并发缺失状态最多打开一个终端窗口。
- 账号密码任意受支持字符都能精确往返，`.env` 原子更新且保持 `0600`。
- 现有自动登录、一次重试、并发刷新、Token 持久化和出站脱敏行为不回归。
