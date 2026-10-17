#!/usr/bin/env node
/**
 * CLI Web 控制台（agy 初版）服务端
 * 零依赖：仅使用 Node.js 内置模块；单进程；仅监听 127.0.0.1:7981。
 * 启动：node agy/server.mjs
 * 跨平台：路径统一用 path 模块，主目录用 os.homedir()，平台差异用 process.platform 分支。
 */

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ============================================================
// 分区 1：常量与跨平台工具
// ============================================================

const PORT = 7981;
const HOST = '127.0.0.1';
const MAX_BODY_SIZE = 5 * 1024 * 1024; // 请求体上限 5MB
const MAX_RECENTS = 10; // 最近目录最多保留条数
const BIN_CACHE_TTL = 5000; // 二进制安装检测缓存时长（毫秒）

/** 当前注册的 CLI 标识（本阶段仅 agy） */
const CLI_ID = 'agy';

/** 用户主目录（跨平台统一入口） */
function homeDir() {
  return os.homedir();
}

/** 数据目录 ~/.cli-console/ 及其下状态、定义文件 */
const DATA_DIR = path.join(homeDir(), '.cli-console');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DEFINITIONS_DIR = path.join(DATA_DIR, 'definitions');

/** 本文件所在目录（用于定位同目录 index.html） */
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(SERVER_DIR, 'index.html');

/** 平台默认 shell：Windows 用 cmd.exe；macOS/Linux 用 $SHELL（缺省 zsh）。终端会话复用 */
function getShell() {
  return process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/zsh');
}

/** 是否为纯对象（排除数组与 null） */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：覆盖键优先；数组整体替换；未覆盖的键沿用默认值 */
function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** HTTP 业务异常：携带状态码与中文提示 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 统一 JSON 响应 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读取并解析 JSON 请求体，超限/非法时抛出 HttpError */
async function readJsonBody(req, limit = MAX_BODY_SIZE) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, '请求体过大（上限 5MB）');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw new HttpError(400, '请求体不能为空');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

// ============================================================
// 分区 2：状态持久化（~/.cli-console/state.json）
// 结构：{ current: string|null, recents: [{ path, ts }] }
// 文件不存在或损坏均按空状态处理，并在下次保存时重写
// ============================================================

/** 修正并裁剪状态对象，保证结构合法 */
function normalizeState(data) {
  const state = { current: null, recents: [] };
  if (isPlainObject(data)) {
    if (typeof data.current === 'string' && data.current) {
      state.current = data.current;
    }
    if (Array.isArray(data.recents)) {
      state.recents = data.recents
        .filter((r) => isPlainObject(r) && typeof r.path === 'string' && r.path)
        .map((r) => ({ path: r.path, ts: Number(r.ts) || 0 }))
        .slice(0, MAX_RECENTS);
    }
  }
  return state;
}

/** 读取状态；文件不存在/损坏时回退为空状态并尝试重写 */
async function loadState() {
  let raw = null;
  try {
    raw = await fsp.readFile(STATE_FILE, 'utf8');
  } catch {
    // 文件不存在：直接使用空状态
  }
  if (raw !== null) {
    try {
      return normalizeState(JSON.parse(raw));
    } catch {
      // 损坏：按空状态处理并重写
    }
  }
  const empty = normalizeState(null);
  await saveState(empty).catch(() => {});
  return empty;
}

/** 写入状态（目录不存在则创建） */
async function saveState(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** 选择工作目录：校验后更新 current 与 recents（去重置顶、裁剪 10 条） */
async function selectWorkdir(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new HttpError(400, '缺少 path 参数');
  }
  const target = path.resolve(rawPath);
  const st = await fsp.stat(target).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new HttpError(400, '路径不存在或不是目录：' + target);
  }
  const state = await loadState();
  state.current = target;
  state.recents = [
    { path: target, ts: Date.now() },
    ...state.recents.filter((r) => r.path !== target),
  ].slice(0, MAX_RECENTS);
  await saveState(state);
  return state;
}

// ============================================================
// 分区 3：CLI definition（内嵌默认定义 + 用户覆盖合并）
// 用户覆盖文件：~/.cli-console/definitions/agy.json
// ============================================================

/** agy 默认探测规则（内嵌常量；迁移到 gemini 时修改此常量或写覆盖文件即可） */
const DEFAULT_AGY_DEFINITION = {
  id: 'agy',
  name: 'agy',
  binary: 'agy',
  startCommand: 'agy',
  nonInteractiveTemplate: 'agy -p "{prompt}"',
  candidates: {
    commands: { dirs: ['.agy/commands'] },
    skills: { dirs: ['.agy/skills'] },
    docs: { dirs: ['.agy/docs'], files: ['AGY.md'] },
    mcp: { files: ['.agy/mcp.json', '.mcp.json'] },
    settings: { files: ['.agy/settings.json', '.agy/config.json'] },
  },
};

/** 加载生效定义：默认定义 + 用户覆盖深合并；覆盖文件非法时忽略并标记 overrideInvalid */
async function loadDefinition(id = CLI_ID) {
  const meta = { overrideUsed: false, overrideInvalid: false };
  const overrideFile = path.join(DEFINITIONS_DIR, `${id}.json`);
  let override = null;
  let raw = null;
  try {
    raw = await fsp.readFile(overrideFile, 'utf8');
  } catch {
    // 覆盖文件不存在：无覆盖，属正常情况
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        override = parsed;
        meta.overrideUsed = true;
      } else {
        meta.overrideInvalid = true;
      }
    } catch {
      meta.overrideInvalid = true;
    }
  }
  const definition = override ? deepMerge(DEFAULT_AGY_DEFINITION, override) : DEFAULT_AGY_DEFINITION;
  return { definition, meta };
}

/** 保存用户覆盖定义：校验必要字段后写入 ~/.cli-console/definitions/agy.json */
async function saveDefinitionOverride(body) {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'definition 必须是 JSON 对象');
  }
  if (body.id !== CLI_ID) {
    throw new HttpError(400, `definition.id 必须为 "${CLI_ID}"（当前仅支持该 CLI）`);
  }
  if (!isPlainObject(body.candidates)) {
    throw new HttpError(400, 'definition 缺少 candidates 字段');
  }
  await fsp.mkdir(DEFINITIONS_DIR, { recursive: true });
  const file = path.join(DEFINITIONS_DIR, `${CLI_ID}.json`);
  await fsp.writeFile(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return file;
}

// ============================================================
// 分区 4：二进制可用性检测（PATH 探测 + 数秒缓存）
// ============================================================

/** 单次探测：unix 用 which，Windows 用 where；命令不存在/退出码非 0 视为未安装 */
function detectBinary(binary) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    let child;
    try {
      child = spawn(cmd, [binary], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** 带缓存的探测：同一二进制 BIN_CACHE_TTL 内复用结果，避免每次请求都 spawn */
const binaryCache = new Map(); // binary -> { promise, ts }
function isBinaryInstalled(binary) {
  const now = Date.now();
  const hit = binaryCache.get(binary);
  if (hit && now - hit.ts < BIN_CACHE_TTL) {
    return hit.promise;
  }
  const promise = detectBinary(binary);
  binaryCache.set(binary, { promise, ts: now });
  return promise;
}

// ============================================================
// 分区 5：REST API 处理器
// 本阶段：health / clis / definition / workdir / scan（项目扫描）/ file（只读读取）
// 文件写入/删除、MCP / Settings 管理、工具面板（tree / scripts）见分区 6
// ============================================================

/** GET /api/health */
async function handleHealth(res) {
  await sendJson(res, 200, {
    ok: true,
    port: PORT,
    platform: process.platform,
    node: process.version,
  });
}

/** GET /api/clis：注册的 CLI 列表 + PATH 安装检测 */
async function handleListClis(res) {
  const installed = await isBinaryInstalled(DEFAULT_AGY_DEFINITION.binary);
  await sendJson(res, 200, {
    clis: [
      {
        id: DEFAULT_AGY_DEFINITION.id,
        name: DEFAULT_AGY_DEFINITION.name,
        binary: DEFAULT_AGY_DEFINITION.binary,
        installed,
      },
    ],
  });
}

/** GET /api/definition?id=agy */
async function handleGetDefinition(res, query) {
  const id = query.get('id') || CLI_ID;
  if (id !== CLI_ID) {
    throw new HttpError(404, `未注册的 CLI：${id}`);
  }
  const { definition, meta } = await loadDefinition(id);
  await sendJson(res, 200, { definition, meta });
}

/** PUT /api/definition?id=agy：body 为完整 definition JSON，写用户覆盖文件 */
async function handlePutDefinition(req, res, query) {
  const id = query.get('id') || CLI_ID;
  if (id !== CLI_ID) {
    throw new HttpError(404, `未注册的 CLI：${id}`);
  }
  const body = await readJsonBody(req);
  await saveDefinitionOverride(body);
  const { definition, meta } = await loadDefinition(id);
  await sendJson(res, 200, { definition, meta });
}

/** GET /api/workdir：当前工作目录与最近目录 */
async function handleGetWorkdir(res) {
  const state = await loadState();
  await sendJson(res, 200, { current: state.current, recents: state.recents });
}

/** GET /api/workdir/browse?path=...：列出子目录（仅目录不含文件）；缺省从主目录开始 */
async function handleBrowseWorkdir(res, query) {
  const raw = query.get('path');
  const target = raw && raw.trim() !== '' ? path.resolve(raw) : homeDir();
  const st = await fsp.stat(target).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new HttpError(404, '路径不存在或不是目录：' + target);
  }
  let entries;
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch {
    throw new HttpError(403, '无法读取该目录（权限不足）：' + target);
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const parent = path.dirname(target);
  await sendJson(res, 200, {
    path: target,
    parent, // 根目录时 parent 等于自身，前端据此禁用「上一级」
    dirs,
  });
}

/** POST /api/workdir/select：body { path }，校验后更新状态并返回 */
async function handleSelectWorkdir(req, res) {
  const body = await readJsonBody(req);
  const state = await selectWorkdir(body && body.path);
  await sendJson(res, 200, { current: state.current, recents: state.recents });
}

/** GET /api/file?path=...：只读读取当前工作目录内的 utf8 文本文件（越界 403 / 缺失 404） */
async function handleReadFile(res, query) {
  const target = await resolveInWorkdir(query.get('path'));
  const st = await fsp.stat(target).catch(() => null);
  if (!st) {
    throw new HttpError(404, '文件不存在：' + target);
  }
  if (!st.isFile()) {
    throw new HttpError(400, '该路径不是文件：' + target);
  }
  const content = await fsp.readFile(target, 'utf8');
  await sendJson(res, 200, { path: target, size: st.size, content });
}

// 扫描目录收集文件的个数上限
const SCAN_FILE_LIMIT = 500;

/** 递归收集目录下所有文件：BFS，name 为相对该目录的路径，最多 SCAN_FILE_LIMIT 个 */
async function collectDirFiles(absDir) {
  const out = [];
  const queue = [[absDir, '']];
  while (queue.length > 0 && out.length < SCAN_FILE_LIMIT) {
    const [dir, relBase] = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限或目录已消失：跳过该层
    }
    const subDirs = [];
    for (const entry of entries) {
      if (out.length >= SCAN_FILE_LIMIT) {
        break;
      }
      const relPath = relBase ? relBase + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        subDirs.push([path.join(dir, entry.name), relPath]);
      } else if (entry.isFile()) {
        out.push({ name: relPath, path: path.join(dir, entry.name) });
      }
    }
    queue.push(...subDirs);
  }
  return out;
}

/** 扫描单类配置：dirs 候选首个命中即递归收集；否则 files 候选中每个存在的文件都进结果 */
async function scanCategory(root, cand) {
  const result = { candidate: null, items: [] };
  if (!isPlainObject(cand)) {
    return result;
  }
  const dirs = Array.isArray(cand.dirs) ? cand.dirs : [];
  for (const rel of dirs) {
    if (typeof rel !== 'string' || rel === '') {
      continue;
    }
    const abs = path.join(root, rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (st && st.isDirectory()) {
      result.candidate = abs; // 首个命中生效
      result.items = await collectDirFiles(abs);
      return result;
    }
  }
  const files = Array.isArray(cand.files) ? cand.files : [];
  for (const rel of files) {
    if (typeof rel !== 'string' || rel === '') {
      continue;
    }
    const abs = path.join(root, rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (st && st.isFile()) {
      result.items.push({ name: rel, path: abs });
      if (!result.candidate) {
        result.candidate = abs;
      }
    }
  }
  return result;
}

/** GET /api/scan：按生效 definition 的候选规则扫描当前工作目录 */
async function handleScan(res) {
  const state = await loadState();
  if (!state.current) {
    throw new HttpError(400, '未选择工作目录');
  }
  const { definition } = await loadDefinition(CLI_ID);
  const cand = isPlainObject(definition.candidates) ? definition.candidates : {};
  const categories = {};
  for (const key of ['commands', 'skills', 'docs', 'mcp', 'settings']) {
    const hit = await scanCategory(state.current, cand[key]);
    // mcp/settings 返回 { candidate, files: [绝对路径] }，并附 items 便于展示相对名
    categories[key] = key === 'mcp' || key === 'settings'
      ? { candidate: hit.candidate, files: hit.items.map((i) => i.path), items: hit.items }
      : hit;
  }
  await sendJson(res, 200, { categories });
}

// ============================================================
// 分区 6：文件写入/删除 + MCP / Settings 管理 + 工具面板（tree / scripts）
// 所有写/删路径统一做工作目录边界校验（越界 403）；配置写回前自动备份为
// <path>.bak；JSON 校验失败不写入。Skills 的新建/编辑/删除复用 /api/file。
// ============================================================

/** 校验绝对路径位于当前工作目录内（未选目录 400 / 越界 403） */
async function assertInsideWorkdir(target) {
  const state = await loadState();
  if (!state.current) {
    throw new HttpError(400, '未选择工作目录');
  }
  const rel = path.relative(state.current, target);
  const escaped = rel === '..' || rel.startsWith('..' + path.sep);
  if (path.isAbsolute(rel) || escaped) {
    throw new HttpError(403, '路径越界：仅允许访问当前工作目录内的路径');
  }
}

/** 解析请求中的 path 参数并校验在工作目录内（缺参 400 / 越界 403），返回绝对路径 */
async function resolveInWorkdir(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HttpError(400, '缺少 path 参数');
  }
  const target = path.resolve(raw);
  await assertInsideWorkdir(target);
  return target;
}

/** POST /api/file：body { path, content }，写入 utf8 文本文件（允许新建，父目录自动创建） */
async function handleWriteFile(req, res) {
  const body = await readJsonBody(req);
  const target = await resolveInWorkdir(body && body.path);
  const content = body && typeof body.content === 'string' ? body.content : '';
  const st = await fsp.stat(target).catch(() => null);
  if (st && st.isDirectory()) {
    throw new HttpError(400, '该路径是目录，不能作为文件写入：' + target);
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, 'utf8');
  await sendJson(res, 200, { ok: true, path: target });
}

/** DELETE /api/file?path=...：删除工作目录内的文件（不存在 404） */
async function handleDeleteFile(res, query) {
  const target = await resolveInWorkdir(query.get('path'));
  const st = await fsp.stat(target).catch(() => null);
  if (!st) {
    throw new HttpError(404, '文件不存在：' + target);
  }
  if (!st.isFile()) {
    throw new HttpError(400, '该路径不是文件：' + target);
  }
  await fsp.unlink(target);
  await sendJson(res, 200, { ok: true });
}

/** 原文件存在时复制为 <path>.bak（返回是否已备份） */
async function backupFileIfExists(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) {
    return false;
  }
  await fsp.copyFile(file, file + '.bak');
  return true;
}

/** 定位某类配置的目标文件：返回首个已存在文件；无命中时取首个 files 候选路径（exists:false，供新建写入） */
async function resolveCategoryFile(categoryKey) {
  const state = await loadState();
  if (!state.current) {
    throw new HttpError(400, '未选择工作目录');
  }
  const { definition } = await loadDefinition(CLI_ID);
  const candidates = isPlainObject(definition.candidates) ? definition.candidates : {};
  const cand = candidates[categoryKey];
  const hit = await scanCategory(state.current, cand);
  if (hit.items.length > 0) {
    return { path: hit.items[0].path, exists: true };
  }
  const files = isPlainObject(cand) && Array.isArray(cand.files) ? cand.files : [];
  const firstRel = files.find((rel) => typeof rel === 'string' && rel !== '');
  return firstRel ? { path: path.join(state.current, firstRel), exists: false } : null;
}

// ---- MCP 管理 ----

/** 解析 MCP 配置文本 → [{ name, command, args, env }]；含 mcpServers 键则用它，否则整体视为 name→config */
function parseMcpServers(raw) {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return []; // 文件损坏：按空列表处理
  }
  if (isPlainObject(data) && isPlainObject(data.mcpServers)) {
    data = data.mcpServers;
  }
  if (!isPlainObject(data)) {
    return [];
  }
  const servers = [];
  for (const [name, cfg] of Object.entries(data)) {
    const c = isPlainObject(cfg) ? cfg : {};
    servers.push({
      name,
      command: typeof c.command === 'string' ? c.command : '',
      args: Array.isArray(c.args) ? c.args : [],
      env: isPlainObject(c.env) ? c.env : {},
    });
  }
  return servers;
}

/** 读取 MCP 配置为 { mcpServers } 结构：不存在/损坏时回退为空结构（写回前已有 .bak 备份原件） */
async function readMcpDoc(file) {
  let doc = { mcpServers: {} };
  if (file.exists) {
    const raw = await fsp.readFile(file.path, 'utf8').catch(() => null);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (isPlainObject(parsed)) {
          doc = { mcpServers: isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed };
        }
      } catch {
        // 原文件不是合法 JSON：按空结构重建
      }
    }
  }
  return doc;
}

/** GET /api/mcp：读取首个命中的 MCP 配置文件并解析为 servers 列表 */
async function handleGetMcp(res) {
  const file = await resolveCategoryFile('mcp');
  if (!file || !file.exists) {
    await sendJson(res, 200, { path: file ? file.path : null, exists: false, servers: [] });
    return;
  }
  const raw = await fsp.readFile(file.path, 'utf8').catch(() => null);
  await sendJson(res, 200, {
    path: file.path,
    exists: raw !== null,
    servers: raw === null ? [] : parseMcpServers(raw),
  });
}

/** PUT /api/mcp/entry：body { name, command, args?, env? }，合并写入 mcpServers 结构（先备份 .bak） */
async function handlePutMcpEntry(req, res) {
  const body = await readJsonBody(req);
  const name = body && typeof body.name === 'string' ? body.name.trim() : '';
  const command = body && typeof body.command === 'string' ? body.command.trim() : '';
  if (name === '') {
    throw new HttpError(400, 'name 不能为空（MCP server 条目必须有名称）');
  }
  if (command === '') {
    throw new HttpError(400, 'command 不能为空（MCP server 条目必须有启动命令）');
  }
  const args = Array.isArray(body.args) ? body.args.map((a) => String(a)) : [];
  const env = {};
  if (isPlainObject(body.env)) {
    for (const [k, v] of Object.entries(body.env)) {
      env[String(k)] = typeof v === 'string' ? v : String(v);
    }
  }
  const file = await resolveCategoryFile('mcp');
  if (!file) {
    throw new HttpError(400, 'definition 未配置 mcp 候选文件路径，无法写入');
  }
  const doc = await readMcpDoc(file);
  const backedUp = await backupFileIfExists(file.path);
  doc.mcpServers[name] = { command, args, env };
  await fsp.mkdir(path.dirname(file.path), { recursive: true });
  await fsp.writeFile(file.path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  await sendJson(res, 200, { ok: true, path: file.path, backedUp });
}

/** DELETE /api/mcp/entry?name=...：备份后删除该条目（文件或条目不存在 404） */
async function handleDeleteMcpEntry(res, query) {
  const name = (query.get('name') || '').trim();
  if (name === '') {
    throw new HttpError(400, '缺少 name 参数');
  }
  const file = await resolveCategoryFile('mcp');
  if (!file || !file.exists) {
    throw new HttpError(404, 'MCP 配置文件不存在：' + (file ? file.path : '（未配置候选路径）'));
  }
  const doc = await readMcpDoc(file);
  if (!Object.prototype.hasOwnProperty.call(doc.mcpServers, name)) {
    throw new HttpError(404, '该 server 条目不存在：' + name);
  }
  const backedUp = await backupFileIfExists(file.path);
  delete doc.mcpServers[name];
  await fsp.writeFile(file.path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  await sendJson(res, 200, { ok: true, path: file.path, backedUp });
}

// ---- Settings 管理 ----

/** GET /api/settings：读取首个命中的 settings 文件原文 */
async function handleGetSettings(res) {
  const file = await resolveCategoryFile('settings');
  if (!file || !file.exists) {
    await sendJson(res, 200, { path: file ? file.path : null, exists: false, raw: null });
    return;
  }
  const raw = await fsp.readFile(file.path, 'utf8').catch(() => null);
  await sendJson(res, 200, { path: file.path, exists: raw !== null, raw: raw === null ? null : raw });
}

/** PUT /api/settings：body { raw }，JSON 校验失败 400 且不写入；成功先备份 .bak 再原样写回 */
async function handlePutSettings(req, res) {
  const body = await readJsonBody(req);
  const raw = body && typeof body.raw === 'string' ? body.raw : null;
  if (raw === null) {
    throw new HttpError(400, '缺少 raw 字段（应为 settings 文件的 JSON 文本）');
  }
  try {
    JSON.parse(raw);
  } catch (e) {
    throw new HttpError(400, 'JSON 格式错误，未写入：' + (e && e.message ? e.message : String(e)));
  }
  const file = await resolveCategoryFile('settings');
  if (!file) {
    throw new HttpError(400, 'definition 未配置 settings 候选文件路径，无法写入');
  }
  const backedUp = await backupFileIfExists(file.path);
  await fsp.mkdir(path.dirname(file.path), { recursive: true });
  await fsp.writeFile(file.path, raw, 'utf8');
  await sendJson(res, 200, { ok: true, path: file.path, backedUp });
}

// ---- 常用工具面板 ----

/** GET /api/tree?path=...：列出工作目录内某一层的子目录与文件（缺省从工作目录开始） */
async function handleTree(res, query) {
  const state = await loadState();
  if (!state.current) {
    throw new HttpError(400, '未选择工作目录');
  }
  const raw = query.get('path');
  const target = raw && raw.trim() !== '' ? path.resolve(raw) : state.current;
  await assertInsideWorkdir(target);
  const st = await fsp.stat(target).catch(() => null);
  if (!st) {
    throw new HttpError(404, '路径不存在：' + target);
  }
  if (!st.isDirectory()) {
    throw new HttpError(400, '该路径不是目录：' + target);
  }
  let entries;
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch {
    throw new HttpError(403, '无法读取该目录（权限不足）：' + target);
  }
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  dirs.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  await sendJson(res, 200, { path: target, dirs, files });
}

/** GET /api/scripts：读取工作目录 package.json 的 scripts 字段（读失败/解析失败均按不存在处理） */
async function handleGetScripts(res) {
  const state = await loadState();
  if (!state.current) {
    throw new HttpError(400, '未选择工作目录');
  }
  const file = path.join(state.current, 'package.json');
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (raw === null) {
    await sendJson(res, 200, { exists: false, scripts: {} });
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await sendJson(res, 200, { exists: false, scripts: {} });
    return;
  }
  const scripts = {};
  if (isPlainObject(parsed) && isPlainObject(parsed.scripts)) {
    for (const [name, cmd] of Object.entries(parsed.scripts)) {
      scripts[name] = typeof cmd === 'string' ? cmd : String(cmd);
    }
  }
  await sendJson(res, 200, { exists: true, path: file, scripts });
}

// ============================================================
// 分区 7：Web 终端会话管理（管道模式：spawn 管道 + SSE 推送 + POST 输入）
// 不支持 TUI 全屏程序；stdout/stderr 写环形缓存并广播给 SSE 客户端，
// 输入写 stdin，进程退出自动清理；启动命令用分区 3 的 startCommand 与平台 shell。
// ============================================================

/** 内存会话表：id → { child, kind, cmd, cwd, buffer, sseClients, startedAt, done, killTimer } */
const termSessions = new Map();
const TERM_BUFFER_MAX = 64 * 1024; // 单会话输出环形缓存上限（字节，超出截断头部）
const TERM_KILL_GRACE_MS = 2000;   // SIGTERM 后等待进程退出的宽限期
const TERM_HEARTBEAT_MS = 15000;   // SSE 心跳间隔

/** 构造 SSE 事件帧：payload 按换行拆成多个 data: 行（SSE 规范） */
function sseFrame(eventName, payload) {
  const lines = String(payload).split(/\r?\n/).map((line) => 'data: ' + line);
  return 'event: ' + eventName + '\n' + lines.join('\n') + '\n\n';
}

/** 向会话的全部 SSE 客户端广播事件 */
function pushTermEvent(session, eventName, payload) {
  const frame = sseFrame(eventName, payload);
  for (const client of session.sseClients) {
    try {
      client.res.write(frame);
    } catch {
      // 客户端已断开：等待其 close 事件统一注销
    }
  }
}

/** 追加输出到环形缓存（超过 64KB 截断头部） */
function appendTermBuffer(session, text) {
  session.buffer += text;
  if (Buffer.byteLength(session.buffer) > TERM_BUFFER_MAX) {
    session.buffer = session.buffer.slice(session.buffer.length - TERM_BUFFER_MAX);
  }
}

/** 会话结束：推送 exit、删除会话、关闭全部 SSE 客户端（幂等） */
function finishTermSession(session, id, result) {
  if (session.done) {
    return;
  }
  session.done = true;
  clearTimeout(session.killTimer);
  pushTermEvent(session, 'exit', String(result));
  termSessions.delete(id);
  for (const client of session.sseClients) {
    try {
      client.res.end();
    } catch {
      // 客户端已断开
    }
  }
  session.sseClients.clear();
}

/** POST /api/term：body { kind: 'shell' | 'cli' }，在当前工作目录启动新会话 */
async function handleCreateTerm(req, res) {
  const state = await loadState();
  if (!state.current) {
    throw new HttpError(400, '未选择工作目录');
  }
  const body = await readJsonBody(req);
  const kind = body && body.kind;
  if (kind !== 'shell' && kind !== 'cli') {
    throw new HttpError(400, "kind 必须为 'shell' 或 'cli'");
  }
  const cwd = state.current;
  let child;
  let cmd;
  if (kind === 'shell') {
    // 平台默认 shell：unix 启动交互式 $SHELL（缺省 zsh）；Windows 启动 cmd.exe
    if (process.platform === 'win32') {
      cmd = 'cmd.exe';
      child = spawn('cmd.exe', [], { cwd });
    } else {
      // 复用 getShell()：非 win32 分支返回 $SHELL（缺省 /bin/zsh），以交互模式启动
      const shell = getShell();
      cmd = shell + ' -i';
      child = spawn(shell, ['-i'], { cwd });
    }
  } else {
    // agent CLI：用生效 definition 的启动命令（经 shell 解释；二进制缺失时错误信息会进入输出）
    const { definition } = await loadDefinition(CLI_ID);
    cmd = definition.startCommand;
    child = spawn(cmd, { shell: true, cwd });
  }
  const id = crypto.randomUUID();
  const session = {
    child,
    kind,
    cmd,
    cwd,
    buffer: '',
    sseClients: new Set(),
    startedAt: new Date().toISOString(),
    done: false,
    killTimer: null,
  };
  // stdout / stderr 统一处理：追加缓存 + 广播
  const onData = (chunk) => {
    const text = chunk.toString('utf8');
    appendTermBuffer(session, text);
    pushTermEvent(session, 'out', text);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.stdin.on('error', () => {}); // 进程退出后写 stdin 触发 EPIPE：静默
  child.on('error', (err) => {
    const text = '[进程启动失败] ' + (err && err.message ? err.message : String(err)) + '\n';
    appendTermBuffer(session, text);
    pushTermEvent(session, 'out', text);
    finishTermSession(session, id, -1);
  });
  child.on('exit', (code, signal) => {
    // 信号终止时 exit code 为 null：改用信号名，前端展示更直观
    finishTermSession(session, id, code === null ? (signal || 'unknown') : code);
  });
  termSessions.set(id, session);
  await sendJson(res, 200, { sessionId: id, kind, cmd, cwd });
}

/** GET /api/term：当前全部会话列表 */
async function handleListTerm(res) {
  const sessions = [];
  for (const [id, s] of termSessions) {
    sessions.push({ id, kind: s.kind, cmd: s.cmd, cwd: s.cwd, alive: !s.done, startedAt: s.startedAt });
  }
  await sendJson(res, 200, { sessions });
}

/** GET /api/term/{id}/stream：SSE 输出流（连接先回放缓存，15 秒心跳） */
async function handleTermStream(req, res, id) {
  const session = termSessions.get(id);
  if (!session) {
    throw new HttpError(404, '终端会话不存在或已退出');
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // 连接建立：一次性回放缓存（历史输出），随后注册客户端接收增量
  try {
    if (session.buffer) {
      res.write(sseFrame('out', session.buffer));
    }
  } catch {
    // 会话恰在此刻退出：忽略，后续由 close 清理
  }
  const client = {
    res,
    timer: setInterval(() => {
      try {
        res.write(': ping\n\n'); // SSE 注释行作心跳，防止代理断连
      } catch {
        // 断开由 req close 统一清理
      }
    }, TERM_HEARTBEAT_MS),
  };
  session.sseClients.add(client);
  req.on('close', () => {
    clearInterval(client.timer);
    session.sseClients.delete(client);
  });
}

/** POST /api/term/{id}/input：body { data }，写入子进程 stdin */
async function handleTermInput(req, res, id) {
  const session = termSessions.get(id);
  if (!session) {
    throw new HttpError(404, '终端会话不存在或已退出');
  }
  const body = await readJsonBody(req);
  const data = body && typeof body.data === 'string' ? body.data : '';
  if (data === '') {
    throw new HttpError(400, '缺少 data 字段');
  }
  try {
    session.child.stdin.write(data);
  } catch {
    throw new HttpError(409, '进程输入流不可用（可能已退出）');
  }
  await sendJson(res, 200, { ok: true });
}

/** POST /api/term/{id}/kill：SIGTERM（Windows 直接 kill），2 秒未退则 SIGKILL */
async function handleTermKill(res, id) {
  const session = termSessions.get(id);
  if (!session) {
    throw new HttpError(404, '终端会话不存在或已退出');
  }
  if (process.platform === 'win32') {
    session.child.kill();
  } else {
    session.child.kill('SIGTERM');
    clearTimeout(session.killTimer);
    session.killTimer = setTimeout(() => {
      try {
        session.child.kill('SIGKILL');
      } catch {
        // 进程已退出
      }
    }, TERM_KILL_GRACE_MS);
  }
  await sendJson(res, 200, { ok: true });
}

// ============================================================
// 分区 8：HTTP 服务与路由（静态托管 index.html + API 分发 + 启动）
// ============================================================

/** 托管单文件前端 index.html（每次请求读取，改动即生效） */
async function serveIndex(res) {
  let html;
  try {
    html = await fsp.readFile(INDEX_HTML, 'utf8');
  } catch {
    await sendJson(res, 500, { error: '无法读取同目录下的 index.html' });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

/** 请求分发：解析 method + pathname + searchParams 后路由到对应处理器 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const method = req.method || 'GET';
  const pathname = url.pathname;
  const query = url.searchParams;

  // 静态资源
  if (method === 'GET' && pathname === '/') {
    await serveIndex(res);
    return;
  }
  if (method === 'GET' && pathname === '/favicon.ico') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // API 路由
  if (pathname.startsWith('/api/')) {
    if (method === 'GET' && pathname === '/api/health') {
      await handleHealth(res);
      return;
    }
    if (method === 'GET' && pathname === '/api/clis') {
      await handleListClis(res);
      return;
    }
    if (pathname === '/api/definition') {
      if (method === 'GET') {
        await handleGetDefinition(res, query);
        return;
      }
      if (method === 'PUT') {
        await handlePutDefinition(req, res, query);
        return;
      }
      throw new HttpError(405, '该方法不被支持');
    }
    if (method === 'GET' && pathname === '/api/workdir') {
      await handleGetWorkdir(res);
      return;
    }
    if (method === 'GET' && pathname === '/api/workdir/browse') {
      await handleBrowseWorkdir(res, query);
      return;
    }
    if (method === 'POST' && pathname === '/api/workdir/select') {
      await handleSelectWorkdir(req, res);
      return;
    }
    if (method === 'GET' && pathname === '/api/scan') {
      await handleScan(res);
      return;
    }
    if (method === 'GET' && pathname === '/api/file') {
      await handleReadFile(res, query);
      return;
    }
    if (method === 'POST' && pathname === '/api/file') {
      await handleWriteFile(req, res);
      return;
    }
    if (method === 'DELETE' && pathname === '/api/file') {
      await handleDeleteFile(res, query);
      return;
    }
    if (method === 'GET' && pathname === '/api/mcp') {
      await handleGetMcp(res);
      return;
    }
    if (method === 'PUT' && pathname === '/api/mcp/entry') {
      await handlePutMcpEntry(req, res);
      return;
    }
    if (method === 'DELETE' && pathname === '/api/mcp/entry') {
      await handleDeleteMcpEntry(res, query);
      return;
    }
    if (method === 'GET' && pathname === '/api/settings') {
      await handleGetSettings(res);
      return;
    }
    if (method === 'PUT' && pathname === '/api/settings') {
      await handlePutSettings(req, res);
      return;
    }
    if (method === 'GET' && pathname === '/api/tree') {
      await handleTree(res, query);
      return;
    }
    if (method === 'GET' && pathname === '/api/scripts') {
      await handleGetScripts(res);
      return;
    }
    if (pathname === '/api/term') {
      if (method === 'POST') {
        await handleCreateTerm(req, res);
        return;
      }
      if (method === 'GET') {
        await handleListTerm(res);
        return;
      }
      throw new HttpError(405, '该方法不被支持');
    }
    const termMatch = /^\/api\/term\/([^/]+)\/(stream|input|kill)$/.exec(pathname);
    if (termMatch) {
      const termId = termMatch[1];
      const action = termMatch[2];
      if (action === 'stream' && method === 'GET') {
        await handleTermStream(req, res, termId);
        return;
      }
      if (action === 'input' && method === 'POST') {
        await handleTermInput(req, res, termId);
        return;
      }
      if (action === 'kill' && method === 'POST') {
        await handleTermKill(res, termId);
        return;
      }
      throw new HttpError(405, '该方法不被支持');
    }
    throw new HttpError(404, '接口不存在');
  }

  throw new HttpError(404, '资源不存在');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : '服务器内部错误';
    if (status >= 500) {
      console.error('[CLI Console] 请求处理异常：', err);
    }
    if (!res.headersSent) {
      sendJson(res, status, { error: message });
    } else {
      res.end();
    }
  });
});

// 端口被占用：输出清晰中文错误并以退出码 1 退出
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[CLI Console] 启动失败：端口 ${PORT} 已被占用（${HOST}:${PORT}）。`);
    if (process.platform === 'win32') {
      console.error('请先停止占用该端口的进程后重试，例如：netstat -ano | findstr ' + PORT + ' 查到 PID 后执行 taskkill /PID <pid> /F');
    } else {
      console.error('请先停止占用该端口的进程后重试，例如：lsof -ti tcp:' + PORT + ' | xargs kill');
    }
    process.exit(1);
  }
  console.error('[CLI Console] 服务启动失败：' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[CLI Console] 服务已启动：http://${HOST}:${PORT}`);
  console.log(`[CLI Console] 数据目录：${DATA_DIR}`);
});
