# CLI Console（agy 初版）Spec

## Why
用户公司电脑（Windows）没有 Codex/Trae 类软件，只有 Gemini CLI，希望在浏览器中更好地使用它；本地只有 agy。策略：先在本地（macOS）用 agy 把功能跑通，再把代码复制到公司电脑，把 CLI 定义改成 gemini 即可使用。核心约束：公司电脑可访问 GitHub 但**无法下载安装包**（不能 npm install），只能复制代码，因此项目必须**零依赖、仅两个代码文件、纯 Node 内置模块**。

## What Changes
- 新建项目（**全部代码生成于仓库子目录 `./agy/` 下**，仅两个代码文件，无 package.json/node_modules/构建链/CDN 依赖）：
  - `agy/server.mjs` — Node.js 服务端（仅内置模块：http、fs、path、child_process、os），REST API + SSE 推送
  - `agy/index.html` — 单文件 Web UI（vanilla HTML/CSS/JS），由 server 托管
  - `agy/README.md` — 使用与迁移说明（文档，非代码）
- 启动方式：`node agy/server.mjs` 直接运行，本地与公司电脑（Windows）行为一致
- CLI 适配层：agy 的探测规则（二进制名、启动命令、commands/skills/docs/mcp/settings 候选路径）以常量内嵌在 server.mjs 中，并支持用户级覆盖文件 `~/.cli-console/definitions/agy.json`；到公司电脑仅需把内嵌定义改为 gemini（或写覆盖文件），无需改其他代码
- 工作目录选择：本地目录浏览 API + 最近目录持久化（`~/.cli-console/state.json`）
- Web 终端（管道模式）：`child_process.spawn` 管道会话，输出经 SSE 实时推送、输入经 POST 写入 stdin，支持多会话标签、启动 shell 或 agy
- 项目扫描：按 definition 候选规则识别工作目录中的 commands、skills、docs、MCP、settings，Dashboard 汇总展示
- 管理页：Skills（列表/查看/编辑/新建/删除）、MCP（条目增删改）、Settings（查看/编辑），写回前备份 + 校验
- 常用工具面板：只读文件树 + 快捷命令（git 常用命令、package.json scripts），点击在新终端会话执行
- 安全边界：仅监听 `127.0.0.1`；文件读写路径校验限制在当前工作目录内

## 技术选型对比
需求回顾：纯本地运行、轻量、Web 终端、管理 UI、多 CLI 可扩展；**公司电脑 Windows、不能下载安装、代码靠复制（两个代码文件）**。

| 方案 | 组成 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 零依赖两文件：Node 内置模块服务端（http + SSE + child_process）+ 单文件 vanilla 前端 | `server.mjs` + `index.html` | 复制两个文件即可部署，公司电脑零安装（Gemini CLI 本身依赖 Node，Node 必然可用）；无构建、无 CDN、无原生编译；本地与 Windows 行为一致；迭代修改即改即生效 | 无真 PTY：终端为管道模式，TUI 全屏程序（如 gemini 交互式 TUI）不适用，需走非交互/命令式用法；前端无框架，UI 交互代码手写量稍大；无 xterm.js 的完整终端模拟 | **推荐（采用）** |
| B. Node + node-pty + xterm.js + Vite/React（原方案） | 需 npm install 与构建 | 真 PTY 终端体验最佳；React 开发效率高 | **公司电脑无法 npm install、无法构建**，方案直接不可行；node-pty 需原生编译 | 不采用（约束冲突） |
| C. Go/Rust 单二进制 | Go + creack/pty + 内嵌前端 | 单文件分发、资源低 | 公司电脑无法编译，需本地交叉编译后拷贝 exe，UI 每次改动都要重新编译分发；双技术栈迭代慢 | 不采用 |
| D. Python 全栈（FastAPI + pty） | 后端 + 独立前端 | 后端简单 | 公司电脑 Python 环境不确定；PTY 在 Windows 不可用（pty 模块仅 Unix）；前后端两套代码违背「两个文件」 | 不采用 |
| E. Electron / Tauri 桌面应用 | 打包桌面 App | 原生体验 | 需下载安装包，公司电脑不可行；体积大 | 不采用 |

终端方案子对比（方案 A 内部）：
- `node-pty`：真 TTY，但需原生编译 + npm 下载 → 违背约束，排除
- Windows ConPTY 原生绑定：需编译/复杂 FFI → 排除
- **`child_process.spawn` 管道 + SSE 推流 + POST 输入：零依赖、双平台一致** → 采用；代价是不支持 TUI 全屏交互，agy/gemini 通过命令行参数（如非交互模式 `-p`）使用

**选型结论：方案 A。** 在「不能下载、只能复制」的硬约束下，零依赖两文件是唯一同时满足本地验证与公司落地的架构；管道模式终端虽不支持 TUI，但配合 agent CLI 的非交互模式足以覆盖日常使用。

## 架构设计建议
- **目录结构**（仓库内）：
  ```
  cli-console/
  └── agy/
      ├── server.mjs      # 服务端 + 内嵌 agy definition 常量
      ├── index.html      # 全部前端（样式与脚本内联）
      └── README.md       # 使用/迁移说明
  ```
- **server.mjs 内部分区**（单文件内按注释分区组织，保持可维护）：
  1. 常量与工具：端口、`~/.cli-console/` 目录、跨平台 home/路径工具（`os.homedir()`、`path`）
  2. CLI definition：内嵌 agy 默认定义（二进制名、启动命令、非交互调用模板、commands/skills/docs/mcp/settings 候选路径数组）+ 用户覆盖合并（非法 JSON 回退默认并提示）
  3. 静态服务：托管 index.html
  4. REST API：clis / workdir（浏览、选择、最近） / scan / files（读、写、列表、删除，含路径边界校验） / mcp / settings / skills
  5. 终端会话管理：sessionMap（id → child process），SSE 流端点、输入 POST、kill；进程退出自动清理
  6. 状态持久化：`~/.cli-console/state.json`（当前工作目录、最近目录）
- **通信设计**：查询与操作用 REST（JSON）；终端输出用 SSE（`text/event-stream`，按 sessionId 区分端点，带心跳注释防断连）；终端输入用 POST。选择 SSE 而非 WebSocket 的原因：Node 内置无 WebSocket 服务器，自实现 RFC6455 帧协议复杂度高，SSE 纯 HTTP 零依赖且输出方向单向推送正好匹配场景
- **前端结构**（index.html 内联）：顶部状态栏（当前 CLI + 工作目录 + 切换按钮）→ Tab 导航（Dashboard / Terminal / Skills / MCP / Settings / Tools）→ 各 Tab 为简单渲染函数，共用少量 fetch 封装；终端为「输出滚动区 + 单行输入」管道式 UI
- **迁移到公司电脑的步骤**（写入 README）：复制 `agy/` 两个代码文件 → 确认 Node 可用（Gemini CLI 依赖它）→ `node server.mjs` → 可选：写 `~/.cli-console/definitions/agy.json` 覆盖为 gemini 定义，或直接把 server.mjs 内嵌常量改为 gemini
- **Windows 兼容要点**：只用跨平台 API（`path`、`os.homedir()`、`process.platform` 分支）；shell 启动按平台选择（macOS: `$SHELL`/zsh，Windows: `cmd.exe` 或 PowerShell）；git 等快捷命令选双平台通用命令；文件读写统一 UTF-8，注意 Windows 下 PowerShell 管道输出编码（v1 以 UTF-8 假设并在 README 注明）

## 假设
- agy 的二进制名、启动参数、配置约定未知 → 每类配置维护候选路径数组（首个命中生效），并以用户覆盖文件兜底，无需改代码即可适配真实约定；gemini 同理（其 `.gemini/`、`GEMINI.md` 等约定在迁移时补充进定义即可）
- 公司电脑已安装 Node.js（运行 Gemini CLI 的前提）且版本 ≥ 18（内置 fetch/ESM 支持即可）
- 终端采用管道模式可接受：通过非交互命令用法（如 `gemini -p "<prompt>"`）驱动 agent CLI

## 明确不做（初版）
- 不做真 PTY/TUI 全屏终端（无 node-pty），终端为管道模式，并在 UI 注明此限制
- 不做 npm 依赖、构建链、CDN 外链、数据库
- 不做终端会话跨页面刷新恢复、远程访问、多用户/鉴权
- 不做 agy/gemini 之外更多 CLI 的适配文件（但定义结构保证加一个常量即可扩展）

## Impact
- Affected specs: 无（全新项目）
- Affected code: 新增 `agy/server.mjs`、`agy/index.html`、`agy/README.md`；运行时生成 `~/.cli-console/state.json` 与可选的 `~/.cli-console/definitions/agy.json`。仓库根目录其他文件不动

## ADDED Requirements

### Requirement: 零依赖两文件交付
系统 SHALL 仅由两个代码文件组成（`agy/server.mjs` 与 `agy/index.html`），仅使用 Node.js 内置模块与浏览器原生能力，不含 package.json、node_modules、构建步骤与任何 CDN/外链资源；`node agy/server.mjs` 即可启动并托管 UI。

#### Scenario: 公司电脑可运行
- **WHEN** 将 `agy/server.mjs` 与 `agy/index.html` 复制到 Windows 电脑并执行 `node server.mjs`
- **THEN** 服务启动且浏览器可正常访问与操作，全程无需任何下载安装

### Requirement: CLI 适配层与 agy 适配器
server.mjs SHALL 内嵌 agy definition 常量（二进制名、启动命令、各配置候选路径）并提供注册表式访问；`/api/clis` 返回已注册 CLI 及其二进制可用性检测。

#### Scenario: agy 被注册并可检测
- **WHEN** 请求 `/api/clis`
- **THEN** 返回 agy 及其是否安装（如 PATH 中可找到）

### Requirement: CLI 探测规则可视化管理
UI SHALL 支持查看 agy 探测规则，并支持编辑后保存为用户级覆盖 `~/.cli-console/definitions/agy.json`（未覆盖项沿用内嵌默认）；覆盖文件 JSON 非法时 SHALL 忽略覆盖并提示，保存后扫描即时生效。

#### Scenario: 用户修正探测路径
- **WHEN** 内置候选未命中，用户将 skills 候选改为 `skills/**` 并保存
- **THEN** 重新扫描按新规则展示，覆盖文件持久化、重启后仍生效

### Requirement: 工作目录选择
系统 SHALL 提供目录浏览 API（列出子目录）、选择接口，并将当前目录与最近目录（最多 10 条）持久化到 `~/.cli-console/state.json`。

#### Scenario: 选择工作目录
- **WHEN** 用户在 UI 中选择 `/Users/yu/my/project`
- **THEN** 后续扫描、终端、文件操作均以此为根，并记入最近目录

#### Scenario: 非法路径拒绝
- **WHEN** 浏览不存在的路径
- **THEN** 返回 404 而非崩溃

### Requirement: Web 终端（管道模式）
系统 SHALL 提供基于 `child_process.spawn` 的管道式终端：输出经 SSE 实时推送、输入经 POST 写入 stdin；支持多会话标签、在当前工作目录启动平台默认 shell、一键启动 agy、终止会话并回收资源；UI SHALL 注明「管道模式，不支持 TUI 全屏程序」。

#### Scenario: 命令输出实时回流
- **WHEN** 在终端输入 `git status` 并回车
- **THEN** 输出经 SSE 流式显示在会话输出区

#### Scenario: 启动 agy
- **WHEN** 用户点击「启动 agy」
- **THEN** 新会话在当前工作目录执行 agy 启动命令；二进制缺失时给出提示

#### Scenario: 会话回收
- **WHEN** 用户关闭终端标签或进程自然退出
- **THEN** 子进程被终止、会话资源被清理

### Requirement: 项目扫描（agy commands/skills/docs/mcp/settings）
系统 SHALL 按 definition 候选规则（含用户覆盖）扫描当前工作目录，返回 commands、skills、docs、MCP 配置、settings 的清单（名称、路径、类型），Dashboard 汇总展示；无任何配置时展示空态与放置路径提示。

#### Scenario: 识别 skills
- **WHEN** 工作目录存在命中候选规则的文件（如 `.agy/skills/xxx.md`）
- **THEN** 扫描结果 skills 列表包含 xxx，可点开查看内容

### Requirement: Skills 管理
系统 SHALL 支持在探测到的 skills 目录内列表、查看、编辑、新建、删除 skill 文件，删除需二次确认，操作 SHALL 限定在 skills 目录内。

#### Scenario: 新建 skill
- **WHEN** 用户新建 `my-skill`
- **THEN** 在 skills 目录创建 Markdown 文件并出现在列表中

### Requirement: MCP 管理
系统 SHALL 读取 agy MCP 配置文件，支持新增、编辑、删除 server 条目（名称、command、args、env），写回前自动备份（`.bak`）并做 JSON 校验，校验失败不写入。

#### Scenario: 新增 MCP server
- **WHEN** 提交合法条目
- **THEN** 配置文件更新且生成备份，列表刷新

#### Scenario: 非法配置拒绝
- **WHEN** 提交缺少 command 的条目
- **THEN** 报错且配置文件不变

### Requirement: Settings 管理
系统 SHALL 支持 agy settings 文件查看与编辑（JSON 校验），保存前自动备份，校验失败不写回。

#### Scenario: 编辑 settings
- **WHEN** 修改 JSON 并保存
- **THEN** 校验通过后写回并生成备份；非法 JSON 报错且不写回

### Requirement: 常用工具面板
系统 SHALL 提供：只读文件树浏览（懒加载）；快捷命令面板（git 双平台通用命令 + package.json scripts 解析），点击后在新终端会话中于当前工作目录执行。

#### Scenario: 运行 package script
- **WHEN** 用户点击 `dev` script
- **THEN** 新终端会话在当前工作目录执行该 script

### Requirement: 本地安全边界
服务端 SHALL 仅监听 `127.0.0.1`；所有文件读写 API SHALL 做路径归一化与边界校验，仅允许访问当前工作目录及其下探测到的配置路径。

#### Scenario: 越界访问拒绝
- **WHEN** 文件 API 收到工作目录之外的路径（`/etc/passwd` 或 `../` 逃逸）
- **THEN** 返回 403 拒绝

### Requirement: 跨平台兼容（macOS 开发 / Windows 运行）
代码 SHALL 仅使用跨平台 Node API：路径经 `path` 处理、home 经 `os.homedir()`、shell 与快捷命令按 `process.platform` 分支适配；不得使用 Unix 专有 API。

#### Scenario: 平台 shell 正确
- **WHEN** 分别在 macOS 与 Windows 启动 shell 会话
- **THEN** macOS 使用 `$SHELL`（默认 zsh），Windows 使用 `cmd.exe`/PowerShell

## 非功能要求
- 启动：`node agy/server.mjs` 单命令、单进程、单端口，秒级启动
- 轻量：零 npm 依赖、无构建、无数据库，状态仅用本地 JSON 文件
