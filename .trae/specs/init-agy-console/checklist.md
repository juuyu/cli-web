# Checklist

- [x] 项目仅两个代码文件：`agy/server.mjs` 与 `agy/index.html`（文档 agy/README.md 除外），全部位于 `./agy/` 下，仓库根目录其他内容不受影响
- [x] 零依赖：仅使用 Node 内置模块与浏览器原生能力，无 package.json/node_modules/构建/CDN 外链；`node agy/server.mjs` 直接启动，`npm run dev`/`npm start` 之类的安装构建流程不存在
- [x] 服务仅监听 127.0.0.1，`/api/health` 可用，index.html 由 server 托管可正常访问
- [x] agy definition 内嵌于 server.mjs 常量（二进制名、启动命令、commands/skills/docs/mcp/settings 候选路径），代码其他位置不散落硬编码路径；`/api/clis` 返回 agy 及安装检测结果
- [x] 可在 UI 查看/编辑 agy 探测规则，保存为 `~/.cli-console/definitions/agy.json` 后重新扫描按新规则生效，重启后仍生效；覆盖文件 JSON 非法时回退内置默认并提示
- [x] 可浏览本地目录并选择工作目录，当前目录与最近目录持久化到 `~/.cli-console/state.json`（最多 10 条）
- [x] Web 终端支持多会话标签（管道模式）：输出经 SSE 实时显示，输入经 POST 到达子进程 stdin，kill/退出后会话资源回收；UI 注明不支持 TUI 全屏程序
- [x] 「启动 agy」可在当前工作目录执行，agy 缺失时有提示；shell 会话按平台选择（macOS zsh/$SHELL，Windows cmd/PowerShell 分支逻辑存在）
- [x] 项目扫描能识别工作目录内 agy 的 commands/skills/docs/mcp/settings 并在 Dashboard 汇总，空目录显示空态与放置路径提示
- [x] Skills 页可列表/查看/编辑/新建/删除，删除有二次确认，操作限定在 skills 目录内
- [x] MCP 页可增删改 server 条目，保存前生成 .bak 备份；非法条目（如缺 command）被拒绝且配置不变
- [x] Settings 页可查看/编辑 JSON，非法 JSON 校验失败不写回，合法保存生成备份
- [x] 工具面板文件树只读可用；点击 package.json script 或 git 快捷命令会在新终端会话执行（命令双平台通用）
- [x] 文件读写 API 对工作目录之外的路径（含 `../` 逃逸与绝对路径如 /etc/passwd）返回 403/404 拒绝
- [x] 跨平台自查通过：仅用 path/os.homedir/process.platform 等跨平台 API，无 Unix 专有调用，文件读写统一 UTF-8
- [x] `agy/README.md` 包含：本地启动使用说明 + 公司电脑（Windows、无法下载）迁移步骤（复制两文件、切换 gemini 定义、非交互用法）
