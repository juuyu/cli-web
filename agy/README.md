# CLI Console（agy 初版）

本地 CLI Web 控制台：在浏览器里管理 agent CLI（初版适配 agy）的工作目录、终端、Skills、MCP 与 Settings。**零依赖、仅两个代码文件**（`server.mjs` + `index.html`），只使用 Node.js 内置模块与浏览器原生能力，无 npm install、无构建、无 CDN 外链。

## 启动

```bash
node agy/server.mjs
```

然后把两个文件复制到任意目录时，直接 `node server.mjs` 也可以。浏览器打开 <http://127.0.0.1:7981> 即可使用。

## 环境要求

- Node.js ≥ 18（仅内置模块，无需任何第三方包）

## 功能清单

- **工作目录**：目录浏览弹窗选择当前工作目录，最近目录持久化（`~/.cli-console/state.json`，最多 10 条）
- **Terminal**：管道模式 Web 终端，多会话标签；输出经 SSE 实时推送、输入经 POST 写入子进程 stdin；支持启动平台默认 shell 与 agent CLI，可终止会话（管道模式不支持 TUI 全屏程序）
- **Dashboard**：按探测规则扫描工作目录中的 commands / skills / docs / MCP / settings 并汇总展示，空态给出放置路径提示
- **Skills**：列表 / 查看 / 编辑 / 新建 / 删除（删除有二次确认），操作限定在命中的 skills 目录内
- **MCP**：server 条目增删改（name / command / args / env），写回前自动备份 `.bak`，条目校验失败不写入
- **Settings**：JSON 原文查看与编辑，双重 JSON 校验，保存前自动备份 `.bak`
- **Tools**：只读懒加载文件树；git 快捷命令与 package.json scripts 一键在终端会话执行
- **探测规则编辑**：查看 / 修改 CLI 探测规则（definition），保存为用户级覆盖文件，重扫即时生效

## 公司电脑（Windows、无法下载安装）迁移步骤

公司电脑只需复制文件、不下载任何东西：

1. **复制两个代码文件**：把 `agy/server.mjs` 与 `agy/index.html` 放到同一目录（如 `D:\cli-console\`）。
2. **确认 Node 可用**：命令行执行 `node -v`，应输出 ≥ 18 的版本号（Gemini CLI 本身依赖 Node，通常已具备）。
3. **启动**：`node server.mjs`，浏览器打开 `http://127.0.0.1:7981`。
4. **把 CLI 从 agy 切换为 gemini**（二选一）：
   - **方式 A（推荐，不改代码）**：写用户级覆盖文件 `%USERPROFILE%\.cli-console\definitions\agy.json`，内容如下（`id` 固定为 `agy`，其余字段指向 gemini 约定）：

     ```json
     {
       "id": "agy",
       "name": "gemini",
       "binary": "gemini",
       "startCommand": "gemini",
       "nonInteractiveTemplate": "gemini -p \"{prompt}\"",
       "candidates": {
         "commands": { "dirs": [".gemini/commands"] },
         "skills": { "dirs": [".gemini/skills"] },
         "docs": { "files": ["GEMINI.md"] },
         "mcp": { "files": [".gemini/mcp.json", ".mcp.json"] },
         "settings": { "files": [".gemini/settings.json"] }
       }
     }
     ```

     保存后重新扫描即按新规则生效，重启服务仍有效。也可以直接在网页「探测规则」弹窗里编辑保存。
   - **方式 B（改代码）**：直接修改 `server.mjs` 内的 `DEFAULT_AGY_DEFINITION` 常量，把 `binary` / `startCommand` / `nonInteractiveTemplate` 与 `candidates` 各候选路径改为上述 gemini 值。
5. **终端用法**：终端为**管道模式**（非真 PTY），不支持 TUI 全屏交互界面。使用 agent CLI 时请用非交互命令，例如：

   ```
   gemini -p "帮我解释这个仓库的结构"
   ```

   在终端输入框输入后回车，输出会流式回显。

## Windows 注意事项

- PowerShell / cmd 管道输出若出现中文乱码，可先执行 `chcp 65001` 切换到 UTF-8 代码页。
- 所有数据（状态、最近目录、definition 覆盖）都存放在 `%USERPROFILE%\.cli-console\`（即 `~/.cli-console/`）。

## 隐私与安全

- 服务**仅监听 `127.0.0.1`**，仅本机可访问，无鉴权，请勿自行改为对外监听。
- 所有文件读写 / 删除 API 均做路径归一化与边界校验，仅允许访问当前工作目录内的路径（越界返回 403）。
