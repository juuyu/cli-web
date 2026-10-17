# Tasks

- [x] Task 1: `agy/server.mjs` 骨架：http 服务（仅监听 127.0.0.1）、托管 `agy/index.html`、`/api/health`、状态持久化工具（`~/.cli-console/state.json`：当前目录 + 最近 10 条）、跨平台工具函数（`os.homedir()`、`path`、`process.platform` shell 分支）、JSON 响应与错误封装
  - [x] SubTask 1.1: agy/ 目录工程化配置（agy/package.json、tsconfig、.gitignore、dev 并发脚本）——按最终零依赖架构取消 package.json/tsconfig，改单文件工程
  - [x] SubTask 1.2: agy/server 骨架（Express + /api/health + 静态托管入口 + 仅监听 127.0.0.1）——Express 改为 Node 内置 http（零依赖约束）
  - [x] SubTask 1.3: agy/web 骨架（Vite + React + 布局与路由骨架：Dashboard / Terminal / Skills / MCP / Settings / Tools）——Vite/React 改为单文件 vanilla UI（零依赖约束）
- [x] Task 2: `agy/index.html` UI 骨架：单文件内联样式与脚本；顶部状态栏（当前 CLI + 工作目录 + 切换按钮）；Tab 导航（Dashboard / Terminal / Skills / MCP / Settings / Tools）；共用 fetch 封装与轻量样式（无任何 CDN 依赖）
- [x] Task 3: CLI 适配层：server.mjs 内嵌 agy definition 常量（二进制名、启动命令、commands/skills/docs/mcp/settings 候选路径数组）；用户覆盖加载（`~/.cli-console/definitions/agy.json`，非法 JSON 回退默认并提示）；`/api/clis` 返回注册列表 + 二进制检测（`child_process` 探测 PATH）
- [x] Task 4: 工作目录选择：目录浏览 API（安全列子目录）+ 选择接口 + 最近目录持久化；UI 目录选择弹窗（下拉最近 + 逐级浏览）
- [x] Task 5: Web 终端（管道模式）：会话管理（spawn shell / agy，按 sessionId 隔离）、SSE 输出流端点（含心跳）、POST 输入写 stdin、kill 与退出自动清理；UI 多会话标签（输出滚动区 + 单行输入）、「启动 shell / 启动 agy」按钮、管道模式限制提示
  - [x] SubTask 5.1: server 端会话管理与 SSE/REST 端点
  - [x] SubTask 5.2: UI 终端标签与交互
- [x] Task 6: 项目扫描服务：按 definition 候选规则（含覆盖）扫描当前工作目录 → commands/skills/docs/mcp/settings 清单 API（`/api/scan`）；Dashboard 分区卡片 + 空态与放置路径提示 + 跳转对应 Tab
- [x] Task 7: Skills 管理：skills 目录内列表/查看/编辑/新建/删除（路径限定 skills 目录、删除二次确认），内容查看（纯文本/转义展示即可）
- [x] Task 8: MCP 管理：读取 agy MCP 配置，条目增删改表单（名称/command/args/env），写回前 `.bak` 备份 + JSON 校验，校验失败不写入
- [x] Task 9: Settings 管理：agy settings 文件查看/编辑（JSON 校验 + 备份后写回，失败不写回）
- [x] Task 10: 常用工具面板：只读文件树（懒加载）+ 快捷命令面板（git 双平台通用命令 + package.json scripts 解析），点击新建终端会话执行
- [x] Task 11: 收尾：跨平台自查（无 Unix 专有 API、path/homedir/platform 分支正确、UTF-8 编码）、零依赖自查（仅内置模块、无 CDN）、按 checklist 全量走查（含越界 403、非法 JSON 拒写、agy 缺失提示、覆盖规则生效）、编写 `agy/README.md`（本地使用 + 公司电脑 Windows 迁移步骤：复制两个文件、改 gemini 定义、非交互用法说明）

# Task Dependencies
- Task 1、2 可并行，为所有任务前置
- Task 3、4 可并行（依赖 1/2）
- Task 5 依赖 Task 3（agy 启动命令）、4（当前工作目录）
- Task 6 依赖 Task 3、4
- Task 7、8、9 依赖 Task 6（复用扫描结果与路径边界）
- Task 10 依赖 Task 5（新终端会话执行）与 6（scripts 读取可独立）
- Task 11 依赖全部任务完成
