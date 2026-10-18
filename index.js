/**
 * `dsh-webdav-sync` —— Host 半。
 *
 * 通过 WebDAV 在多设备之间同步 DeepSeek Harness 的**配置**与**插件包**，
 * **不同步会话**。同步机制参考 CC Switch（`farion1231/cc-switch`）的 WebDAV
 * 云同步：远端只放 `manifest.json` + `config.zip` + `plugins.zip` 三个文件，
 * manifest 里记录每个 artifact 的 sha256/大小与整体 snapshotId；上传时
 * artifact 先传、manifest 最后传，下载时先校验 sha256 再落盘。
 *
 * ## 同步内容
 *
 * - `config.zip`（配置文件）：
 *   - `profile/package.json`、`profile/cordis.patch.yml`、`profile/cordis.yml`、
 *     `profile/pnpm-lock.yaml`、`profile/pnpm-workspace.yaml`
 *   - `home/.credentials.yaml`（可由 `syncCredentials` 关闭）、`home/settings.yaml`、
 *     `home/settings.json`
 * - `plugins.zip`（插件包）：profile `dependencies` 里所有 `link:`/`file:` 本地插件包
 *   的源码目录（排除 `node_modules/`、`.git/`、`.scratch/`、日志），根下
 *   `_plugins.json` 记录每包的原路径。
 * - **不包含**：`sessions/`、`attachments/`、`cache/`、`logs/`、`.plugin-manager/`、
 *   `node_modules/`、`dsh-runtimes/`、`storages/`、`.anonymous-user-id`。
 *
 * ## 配置与凭据
 *
 * WebDAV 的地址/账户/根目录等是 volatile 配置字段（设置页可改、热生效）；
 * **密码不进配置文件**，存放在 DSH 凭据库的 `passwordRef`（默认
 * `DSH_WEBDAV_SYNC_PASSWORD`）下，每次同步时现取。
 *
 * ## 通道
 *
 * 浏览器半（`client.js`）通过 DSH 的 Connection RPC 通道 `/dsh-webdav-sync`
 * 调用这里：`ctx.connection.rpc.handle(RPC_CHANNEL, handler)`。handler 返回
 * `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details: {} } }`
 * —— 后者是 Connection 信封的硬要求，`details` 必须是对象。
 *
 * ## 自动同步
 *
 * `autoSync` 打开时监听 profile 目录与 home 配置文件的变更（fs.watch，1.5s
 * debounce、10s 合并上限），并在内容确实变化时上传；另有 60s 兜底轮询，
 * 防止文件系统事件丢失。判断「是否变化」用本地快照的 snapshotId 与上次成功
 * 同步记录比较，所以不会产生无意义的上传。
 *
 * @module dsh-webdav-sync
 */

import { spawn } from 'node:child_process';
import { existsSync, promises as fs, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

import { zipRead } from './lib/zip.mjs';
import { createWebDav, WebDavError } from './lib/webdav.mjs';
import {
  ARTIFACT_CONFIG,
  ARTIFACT_PLUGINS,
  MANIFEST_NAME,
  buildManifest,
  buildZipArtifact,
  computeSnapshotId,
  normalizeDeviceName,
  normalizeRelativeZipPath,
  parseManifest,
  verifyArtifact,
} from './lib/snapshot.mjs';
import { applySnapshot, ApplyError, readPluginList, writeFileAtomic } from './lib/apply.mjs';

// ─── 常量 ────────────────────────────────────────────────────

/** Cordis 插件名；同时是 Loader 行 id 与设置命名空间。 */
export const name = 'webdav-sync';

/** 本插件的设置命名空间（= Loader 行 id，不是包名）。 */
export const SETTINGS_NAMESPACE = name;

/** 浏览器半调用本插件动作的 Connection RPC 通道。 */
export const RPC_CHANNEL = '/dsh-webdav-sync';

/** 默认的 WebDAV 密码凭据引用。 */
export const DEFAULT_PASSWORD_REF = 'DSH_WEBDAV_SYNC_PASSWORD';

/**
 * 服务商预设对应的默认 WebDAV 地址（与 client.js 里的服务商下拉保持一致）。
 *
 * 只有坚果云有公开固定的 WebDAV 入口；Nextcloud / 群晖的地址带用户自己的域名，
 * 只能由用户填写，所以留空。
 */
export const PROVIDER_PRESET_BASE_URLS = Object.freeze({
  jianguoyun: 'https://dav.jianguoyun.com/dav/',
  nextcloud: '',
  synology: '',
  custom: '',
});

/**
 * 解析实际使用的 WebDAV 地址。
 *
 * 显式填了地址就用显式值；否则如果用户选了已知服务商预设（坚果云），就回退到
 * 该预设的默认地址。这修掉一个真实踩过的坑：服务商下拉只在「手动切换」时写入
 * 地址，重启后从已保存配置恢复表单时地址栏可能是空的，于是「选了坚果云、账户
 * 密码都填了」仍然报「尚未配置 WebDAV 服务器地址」。
 *
 * @param {object} options 配置快照。
 * @returns {string} 实际使用的地址（可能为空）。
 */
export function resolveBaseUrl(options) {
  const explicit = typeof options?.baseUrl === 'string' ? options.baseUrl.trim() : '';
  if (explicit.length > 0) return explicit;
  const preset = typeof options?.providerPreset === 'string' ? options.providerPreset.trim().toLowerCase() : '';
  return PROVIDER_PRESET_BASE_URLS[preset] ?? '';
}

/** 远端布局版本目录（将来协议不兼容时升级）。 */
export const REMOTE_LAYOUT_VERSION = 'v1';

/** 插件版本（与 package.json 对齐，测试会断言）。 */
export const PLUGIN_VERSION = '0.1.0';

/** profile 目录里参与同步的配置文件。 */
export const PROFILE_CONFIG_FILES = [
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

/** `$DSH_HOME` 根目录里参与同步的配置文件。 */
export const HOME_CONFIG_FILES = ['.credentials.yaml', 'settings.yaml', 'settings.json'];

/** 凭据文件名（开启 `syncCredentials` 时才同步）。 */
export const CREDENTIALS_FILE = '.credentials.yaml';

/** 自动同步的节奏参数。 */
const AUTO_SYNC_DEBOUNCE_MS = 1500;
const AUTO_SYNC_MAX_WAIT_MS = 10_000;
const AUTO_SYNC_POLL_MS = 60_000;

/** 插件包收集的上限（可由配置放宽）。 */
const PLUGIN_MAX_FILES = 2000;
const PLUGIN_MAX_BYTES = 20 * 1024 * 1024;
const PLUGIN_EXCLUDED_DIRS = new Set(['node_modules', '.git', '.scratch', '.pnpm', '.plugin-manager', '.cache']);
const PLUGIN_EXCLUDED_FILE = /(?:\.log|\.tmp|Thumbs\.db|\.DS_Store)$/iu;

/** manifest / 状态 JSON 的读取上限。 */
const MAX_MANIFEST_BYTES = 1024 * 1024;

// ─── Config schema ──────────────────────────────────────────

/**
 * 该行的 Config schema。
 *
 * `.volatile()` 的字段会出现在「设置 → 插件 → WebDAV 云同步」表单里，保存后
 * 立即生效（值解析成带 `.get()` 的活引用）；非 volatile 的是加载期配置，只能
 * 在 `cordis.patch.yml` 里改。
 *
 * 注意：按 id 定向的 patch 会**整块替换** `config`，所以 cordis.patch.yml 里
 * 写到的每个键都必须在这里声明。
 */
export const Config = z.object({
  /** 同步方式；当前只有 WebDAV，保留字段方便将来扩展。 */
  provider: z.string().default('webdav').volatile(),
  /** 服务商预设：jianguoyun / nextcloud / synology / custom。 */
  providerPreset: z.string().default('custom').volatile(),
  /** WebDAV 服务器地址（含路径，例如 https://dav.jianguoyun.com/dav/）。 */
  baseUrl: z.string().default('').volatile(),
  /** WebDAV 账户。 */
  username: z.string().default('').volatile(),
  /** WebDAV 密码的凭据引用名（不是密码本身）。 */
  passwordRef: z.string().role('credential-ref').default(DEFAULT_PASSWORD_REF).volatile(),
  /** 远程根目录（可含多级，例如 dsh-sync）。 */
  remoteRoot: z.string().default('dsh-sync').volatile(),
  /** 同步配置名：同一 WebDAV 上可并存多套配置。 */
  syncProfile: z.string().default('default').volatile(),
  /** 是否在配置变化后自动上传。 */
  autoSync: z.boolean().default(true).volatile(),
  /** 是否把 `.credentials.yaml`（含 API 密钥）一起同步。 */
  syncCredentials: z.boolean().default(true).volatile(),
  /** HTTP 超时（毫秒）。 */
  timeoutMs: z.number().step(1).min(1000).default(30_000),
  /** 单个 artifact 的下载上限（字节）。 */
  maxArtifactBytes: z.number().step(1).min(1024).default(64 * 1024 * 1024),
  /** 单个插件包的大小上限（字节）。 */
  maxPluginBytes: z.number().step(1).min(1024).default(PLUGIN_MAX_BYTES),
  /** 备份保留份数。 */
  backupKeep: z.number().step(1).min(1).default(5),
});

// ─── 通用小工具 ──────────────────────────────────────────────

/**
 * 读取一个配置值，兼容普通值与 schemastery 的 volatile 引用（后者有 `.get()`）。
 *
 * @param {unknown} config 传给 `apply` 的行配置。
 * @param {string} key 字段名。
 * @param {unknown} fallback 缺失或为 null 时的值。
 * @returns {unknown}
 */
export function readOption(config, key, fallback) {
  if (config === null || config === undefined) return fallback;
  let value;
  try {
    value = config[key];
  } catch {
    return fallback;
  }
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      const live = value.get();
      return live === undefined || live === null ? fallback : live;
    } catch {
      return fallback;
    }
  }
  return value;
}

/** 是「非空字符串」吗？ */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 单个远路径段的清洗：只保留安全字符，空白/斜杠/点是禁用词。 */
export function sanitizeRemoteSegment(raw, fallback) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return fallback;
  const cleaned = text.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-').replace(/^\.+$/u, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * 把 remoteRoot 拆成远端目录段（允许 `foo/bar` 这种多级写法）。
 *
 * @param {string} raw 配置里的远程根目录。
 * @returns {string[]} 清洗后的目录段。
 */
export function remoteRootSegments(raw) {
  const segments = String(raw ?? '')
    .split('/')
    .map((segment) => sanitizeRemoteSegment(segment, ''))
    .filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments : ['dsh-sync'];
}

/**
 * 解析 DSH 主目录：`$DSH_HOME` > `~/.dsh`（与 `@deepseek-ai/dsh-home-paths` 一致）。
 *
 * @returns {string} 绝对路径。
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim().replace(/^~(?=$|[\\/])/u, os.homedir()));
  }
  return path.join(os.homedir(), '.dsh');
}

/**
 * 解析当前 profile 的目录与名字。
 *
 * 优先读 `profileContext` 服务（它由 app-boot 提供，`name`/`dir` 是公开字段，
 * shell-env 也用同一对字段拼 `DSH_PROFILE` / `DSH_PROFILE_DIR`）；其次读启动
 * 环境里的同名变量；最后退回 `$DSH_HOME/profiles/desktop`。
 *
 * @param {object} ctx Cordis 上下文。
 * @returns {{ dir: string, name: string }}
 */
export function resolveProfileInfo(ctx) {
  let fromService;
  try {
    fromService = ctx.get?.('profileContext');
  } catch {
    fromService = undefined;
  }
  if (fromService !== null && fromService !== undefined) {
    const dir = typeof fromService.dir === 'string' && fromService.dir.length > 0 ? fromService.dir : undefined;
    const profileName = typeof fromService.name === 'string' && fromService.name.length > 0 ? fromService.name : undefined;
    if (dir !== undefined) {
      return { dir: path.resolve(dir), name: profileName ?? path.basename(dir) };
    }
  }
  const envDir = process.env.DSH_PROFILE_DIR;
  if (typeof envDir === 'string' && envDir.trim().length > 0) {
    return { dir: path.resolve(envDir.trim()), name: process.env.DSH_PROFILE || path.basename(envDir.trim()) };
  }
  const dir = path.join(resolveDshHome(), 'profiles', 'desktop');
  return { dir, name: 'desktop' };
}

/** 插件自己的数据目录（状态、备份、暂存），位于 `$DSH_HOME/webdav-sync` 下。 */
export function syncDataDir(dshHome) {
  return path.join(dshHome, 'webdav-sync');
}

/** 同步状态文件路径。 */
export function stateFilePath(dshHome) {
  return path.join(syncDataDir(dshHome), 'state.json');
}

/** 备份根目录。 */
export function backupsRoot(dshHome) {
  return path.join(syncDataDir(dshHome), 'backups');
}

/** 当前的配置快照（每次动作现读，保证表单改了立即生效）。 */
export function resolveOptions(ctx, config) {
  return {
    provider: String(readOption(config, 'provider', 'webdav')),
    providerPreset: String(readOption(config, 'providerPreset', 'custom')),
    baseUrl: String(readOption(config, 'baseUrl', '')),
    username: String(readOption(config, 'username', '')),
    passwordRef: String(readOption(config, 'passwordRef', DEFAULT_PASSWORD_REF)),
    remoteRoot: String(readOption(config, 'remoteRoot', 'dsh-sync')),
    syncProfile: String(readOption(config, 'syncProfile', 'default')),
    autoSync: readOption(config, 'autoSync', true) !== false,
    syncCredentials: readOption(config, 'syncCredentials', true) !== false,
    timeoutMs: Number(readOption(config, 'timeoutMs', 30_000)),
    maxArtifactBytes: Number(readOption(config, 'maxArtifactBytes', 64 * 1024 * 1024)),
    maxPluginBytes: Number(readOption(config, 'maxPluginBytes', PLUGIN_MAX_BYTES)),
    backupKeep: Number(readOption(config, 'backupKeep', 5)),
  };
}

// ─── 错误类型 ────────────────────────────────────────────────

/** 带稳定错误码的同步错误：错误码会原样出现在 RPC 失败信封里。 */
export class SyncError extends Error {
  /**
   * @param {string} message 面向用户的中文错误信息。
   * @param {string} code 稳定错误码。
   */
  constructor(message, code) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

/** 把任意异常投影成 RPC 失败信封需要的 `{ code, message }`。 */
export function toPublicError(error) {
  if (error instanceof SyncError) return { code: error.code, message: error.message };
  if (error instanceof WebDavError) return { code: error.code, message: error.message };
  if (error instanceof ApplyError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'SYNC_FAILED', message };
}

// ─── 状态持久化 ──────────────────────────────────────────────

/** 读同步状态；文件不存在或损坏时返回空对象（不抛错）。 */
export async function readState(dshHome) {
  try {
    const text = await fs.readFile(stateFilePath(dshHome), 'utf8');
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 写同步状态（原子写）。 */
export async function writeState(dshHome, state) {
  await writeFileAtomic(stateFilePath(dshHome), Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8'));
}

/** 读-改-写同步状态。 */
export async function patchState(dshHome, patch) {
  const current = await readState(dshHome);
  const next = { ...current, ...patch };
  await writeState(dshHome, next);
  return next;
}

// ─── 凭据 ────────────────────────────────────────────────────

/**
 * 解析 WebDAV 密码：先查 DSH 凭据库，再回退到同名环境变量。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {string} ref 凭据引用名。
 * @returns {Promise<string | undefined>} 密码；找不到时 undefined。
 */
export async function resolvePassword(ctx, ref) {
  let credentials;
  try {
    credentials = ctx.get?.('credentials');
  } catch {
    credentials = undefined;
  }
  if (credentials !== undefined && credentials !== null) {
    try {
      const resolved = await credentials.resolve(ref);
      const value = resolved?.value;
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      // 凭据库异常不致命，继续尝试环境变量。
    }
  }
  const fromEnv = process.env[ref];
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined;
}

// ─── 本地快照 ────────────────────────────────────────────────

/**
 * 列出当前 profile 需要同步的配置文件。
 *
 * @returns {Promise<Array<{ path: string, absPath: string }>>} zip 内相对路径 + 绝对路径。
 */
export async function collectConfigEntries(profileDir, dshHome, syncCredentials) {
  const entries = [];
  for (const file of PROFILE_CONFIG_FILES) {
    const absPath = path.join(profileDir, file);
    if (await isFile(absPath)) entries.push({ path: `profile/${file}`, absPath });
  }
  for (const file of HOME_CONFIG_FILES) {
    if (file === CREDENTIALS_FILE && !syncCredentials) continue;
    const absPath = path.join(dshHome, file);
    if (await isFile(absPath)) entries.push({ path: `home/${file}`, absPath });
  }
  return entries;
}

/** 是普通文件吗？ */
async function isFile(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

/** 是目录吗？ */
async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 从 profile 的 `package.json` 解析出所有本地插件包目录。
 *
 * 只认 `link:` / `file:` 两种 spec（registry 包不需要同步源码，靠 lockfile 重装）。
 *
 * @param {string} profileDir profile 目录。
 * @returns {Promise<Array<{ name: string, originalDir: string, spec: string }>>}
 */
export async function listLocalPluginDirs(profileDir) {
  const manifestPath = path.join(profileDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  const dependencies = manifest?.dependencies;
  if (dependencies === null || typeof dependencies !== 'object') return [];
  const result = [];
  for (const [packageName, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') continue;
    const match = /^(?:link|file):(.+)$/u.exec(spec.trim());
    if (match === null) continue;
    const raw = match[1];
    const originalDir = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(profileDir, raw);
    result.push({ name: packageName, originalDir, spec });
  }
  return result;
}

/**
 * 递归收集一个插件包目录里的文件（排除依赖/仓库/日志）。
 *
 * @param {string} root 包目录。
 * @param {number} maxBytes 总大小上限。
 * @param {{ files: number, bytes: number, maxFiles: number }} budget 共享预算。
 * @param {string[]} warnings 警告收集器。
 * @returns {Promise<Array<{ path: string, bytes: Buffer }>>} zip 内相对路径（包内路径）。
 */
async function walkPluginPackage(root, budget, warnings) {
  const files = [];
  /** @type {Array<{ dir: string, prefix: string }>} */
  const queue = [{ dir: root, prefix: '' }];
  while (queue.length > 0) {
    const { dir, prefix } = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`读取插件目录失败 ${dir}: ${error?.message ?? error}`);
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const name = entry.name;
      if (PLUGIN_EXCLUDED_DIRS.has(name)) continue;
      const absPath = path.join(dir, name);
      const relPath = prefix.length > 0 ? `${prefix}/${name}` : name;
      if (entry.isSymbolicLink()) {
        warnings.push(`跳过插件包内的符号链接: ${relPath}`);
        continue;
      }
      if (entry.isDirectory()) {
        queue.push({ dir: absPath, prefix: relPath });
        continue;
      }
      if (!entry.isFile()) continue;
      if (PLUGIN_EXCLUDED_FILE.test(name)) continue;
      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }
      if (budget.files >= budget.maxFiles) {
        throw new SyncError(
          `插件包文件数超过上限（${budget.maxFiles} 个），已放弃本次同步；可在 cordis.patch.yml 调大 maxPluginBytes 或精简插件`,
          'PLUGIN_TOO_LARGE',
        );
      }
      if (budget.bytes + stat.size > budget.maxBytes) {
        throw new SyncError(
          `插件包总大小超过上限（${Math.floor(budget.maxBytes / 1024 / 1024)} MiB），已放弃本次同步；可在 cordis.patch.yml 调大 maxPluginBytes`,
          'PLUGIN_TOO_LARGE',
        );
      }
      budget.files += 1;
      budget.bytes += stat.size;
      files.push({ path: relPath, bytes: await fs.readFile(absPath) });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

/**
 * 构建一份完整的本地快照：配置文件 zip、插件包 zip、manifest。
 *
 * @param {object} options
 * @param {string} options.profileDir profile 目录。
 * @param {string} options.dshHome DSH 主目录。
 * @param {string} options.profileName profile 名。
 * @param {string} options.deviceName 设备名。
 * @param {string} options.dshVersion DSH 版本（可空）。
 * @param {boolean} options.syncCredentials 是否同步 `.credentials.yaml`。
 * @param {number} options.maxPluginBytes 插件包总大小上限。
 * @returns {Promise<object>} 快照对象。
 */
export async function buildLocalSnapshot(options) {
  const { profileDir, dshHome, profileName, deviceName, dshVersion, syncCredentials } = options;
  const configEntries = await collectConfigEntries(profileDir, dshHome, syncCredentials);
  const configFiles = [];
  for (const entry of configEntries) {
    configFiles.push({ path: entry.path, bytes: await fs.readFile(entry.absPath) });
  }
  const configZip = buildZipArtifact(configFiles);

  const warnings = [];
  const budget = {
    files: 0,
    bytes: 0,
    maxFiles: PLUGIN_MAX_FILES,
    maxBytes: Number.isFinite(options.maxPluginBytes) && options.maxPluginBytes > 0 ? options.maxPluginBytes : PLUGIN_MAX_BYTES,
  };
  const localPlugins = await listLocalPluginDirs(profileDir);
  const packages = [];
  const pluginFiles = [];
  for (const plugin of localPlugins) {
    if (!(await isDirectory(plugin.originalDir))) {
      warnings.push(`插件目录不存在，已跳过: ${plugin.name} (${plugin.originalDir})`);
      continue;
    }
    const packageFiles = await walkPluginPackage(plugin.originalDir, budget, warnings);
    packages.push({ name: plugin.name, originalDir: plugin.originalDir });
    for (const file of packageFiles) {
      const zipPath = `${plugin.name}/${file.path}`;
      // 上传侧与下载侧共用同一套路径规则：Linux 上可能出现 Windows 无法表示的
      // 文件名（`:`、尾随点等），这种条目直接跳过并警告，不能整次上传失败。
      try {
        normalizeRelativeZipPath(zipPath);
      } catch (error) {
        warnings.push(`跳过非法文件名的插件文件: ${zipPath}（${error?.message ?? error}）`);
        continue;
      }
      pluginFiles.push({ path: zipPath, bytes: file.bytes });
    }
  }
  pluginFiles.push({
    path: '_plugins.json',
    bytes: Buffer.from(`${JSON.stringify(packages, null, 2)}\n`, 'utf8'),
  });
  pluginFiles.sort((left, right) => left.path.localeCompare(right.path));
  const pluginsZip = buildZipArtifact(pluginFiles);

  const artifacts = {
    [ARTIFACT_CONFIG]: { sha256: configZip.sha256, size: configZip.size },
    [ARTIFACT_PLUGINS]: { sha256: pluginsZip.sha256, size: pluginsZip.size },
  };
  const built = buildManifest({
    artifacts,
    deviceName,
    dshVersion,
    profileName,
    fileCount: configFiles.length + pluginFiles.length,
  });
  return {
    configZip,
    pluginsZip,
    manifest: built.manifest,
    manifestBytes: built.bytes,
    manifestSha256: built.sha256,
    snapshotId: computeSnapshotId(artifacts),
    configFiles,
    pluginFiles,
    packages,
    warnings,
  };
}

// ─── 依赖安装（跨机恢复的收尾步骤） ────────────────────────────

/** 单次 `pnpm install` 的超时（毫秒）。 */
const INSTALL_TIMEOUT_MS = 180_000;

/**
 * 解析一个可用的 pnpm 运行方式。
 *
 * 桌面版把自带运行时作为进程参数传给 Host（`.../primary-runtime/dependencies/pnpm/bin/pnpm.mjs`），
 * 同级还有自带的 `node.exe`；因此优先从 `process.argv` 推断，其次按默认安装路径探测，
 * 都找不到时返回 `undefined`（调用方退回「让用户手动跑命令」的提示）。
 *
 * @returns {{ command: string, args: string[], env?: Record<string, string> } | undefined}
 */
export function resolvePnpmRunner() {
  const isWindows = process.platform === 'win32';
  const nodeName = isWindows ? 'node.exe' : 'node';
  const candidates = [];
  const fromArgv = process.argv.find(
    (arg) => typeof arg === 'string' && /[\\/]pnpm[\\/]bin[\\/]pnpm\.mjs$/iu.test(arg),
  );
  if (typeof fromArgv === 'string') candidates.push(fromArgv);
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    candidates.push(
      path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    );
  }
  for (const entry of candidates) {
    if (!existsSync(entry)) continue;
    const runtimeRoot = path.dirname(path.dirname(path.dirname(path.dirname(entry))));
    const nodeExe = path.join(runtimeRoot, 'dependencies', 'node', 'bin', nodeName);
    if (existsSync(nodeExe)) return { command: nodeExe, args: [entry] };
    // Electron 可执行文件加 ELECTRON_RUN_AS_NODE 也能当 node 用。
    return { command: process.execPath, args: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return undefined;
}

/**
 * 跑一个子进程并收集输出（带超时）。
 *
 * @param {{ command: string, args: string[], env?: Record<string, string> }} runner
 * @param {string[]} args 追加参数。
 * @param {string} cwd 工作目录。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<{ code: number, output: string }>}
 */
function spawnCapture(runner, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(runner.command, [...runner.args, ...args], {
        cwd,
        env: { ...process.env, ...(runner.env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, output: String(error?.message ?? error) });
      return;
    }
    let output = '';
    const append = (chunk) => {
      output = (output + chunk.toString('utf8')).slice(-4000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${error?.message ?? error}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : -1, output });
    });
  });
}

/**
 * 跨机恢复后自动安装依赖。
 *
 * 顺序：先 profile（建立 `node_modules` 链接），再每个回退到 profile 内的插件目录
 * （装插件自身的依赖，例如 `@deepseek-ai/schemastery`）。任一失败都不抛出，只把结果
 * 带回去让界面提示手动命令。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {{ profileDir: string, pluginDirs: string[] }} input
 * @returns {Promise<{ attempted: boolean, ok: boolean, reason?: string, results: Array<object> }>}
 */
export async function installFallbackDependencies(ctx, input) {
  const runner = resolvePnpmRunner();
  if (runner === undefined) {
    return {
      attempted: false,
      ok: false,
      reason: '未找到 DSH 自带的 pnpm，请手动在 profile 目录运行依赖安装',
      results: [],
    };
  }
  const targets = [
    { label: 'profile', dir: input.profileDir },
    ...input.pluginDirs.map((dir) => ({ label: path.basename(dir), dir })),
  ];
  const results = [];
  for (const target of targets) {
    const startedAt = Date.now();
    const { code, output } = await spawnCapture(runner, ['install'], target.dir, INSTALL_TIMEOUT_MS);
    const item = {
      target: target.label,
      dir: target.dir,
      ok: code === 0,
      code,
      durationMs: Date.now() - startedAt,
      output: output.slice(-600),
    };
    results.push(item);
    ctx.logger?.info?.(`[webdav-sync] 依赖安装 ${target.label}: ${item.ok ? 'ok' : `failed(${code})`}`);
  }
  return { attempted: true, ok: results.every((item) => item.ok), results };
}

/** 当前机器的设备名（manifest 里展示用）。 */
export function detectDeviceName() {
  const candidates = [process.env.COMPUTERNAME, process.env.HOSTNAME, os.hostname()];
  for (const candidate of candidates) {
    if (isNonEmptyString(candidate)) return normalizeDeviceName(candidate);
  }
  return 'Unknown Device';
}

/**
 * 读取**下载之前**本地 profile `package.json` 里声明的本地插件目录。
 *
 * 这是插件恢复目标的唯一可信来源：远端快照里的 `package.json` 与
 * `_plugins.json` 都是远端可控数据，不能用来决定写入位置。所以下载流程必须在
 * 写入任何远端配置**之前**调用它，并把结果传给 `applySnapshot`。
 *
 * @param {string} profileDir 当前 profile 目录。
 * @returns {Promise<Map<string, string>>} 包名 → 本地插件目录。
 */
export async function readTrustedLocalDependencies(profileDir) {
  const trusted = new Map();
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'));
  } catch {
    return trusted;
  }
  const dependencies = manifest?.dependencies;
  if (dependencies === null || typeof dependencies !== 'object') return trusted;
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') continue;
    const match = /^(?:link|file):(.+)$/u.exec(spec.trim());
    if (match === null) continue;
    const raw = match[1];
    trusted.set(name, path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(profileDir, raw));
  }
  return trusted;
}

// ─── 远端目录 ────────────────────────────────────────────────

/** 本插件的远端目录段：`[remoteRoot..., 'v1', syncProfile]`。 */
export function remoteDirSegments(options) {
  return [...remoteRootSegments(options.remoteRoot), REMOTE_LAYOUT_VERSION, sanitizeRemoteSegment(options.syncProfile, 'default')];
}

/** 远端目录的展示字符串（以 / 开头）。 */
export function remoteDirDisplay(options) {
  return `/${remoteDirSegments(options).join('/')}`;
}

// ─── 操作会话 ────────────────────────────────────────────────

/**
 * 校验配置并构造一次操作所需的 WebDAV 客户端。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} options 配置快照。
 * @returns {Promise<{ webdav: object, dirSegs: string[], options: object }>}
 */
export async function openSession(ctx, options) {
  // 地址可以是显式填写的，也可以由服务商预设推导（见 resolveBaseUrl）。
  const baseUrl = resolveBaseUrl(options);
  if (!isNonEmptyString(baseUrl)) {
    throw new SyncError(
      '尚未配置 WebDAV 服务器地址：请选择「服务商」预设（坚果云会自动填地址）或在「WebDAV 服务器地址」里手动填写后保存',
      'NOT_CONFIGURED',
    );
  }
  if (!isNonEmptyString(options.username)) {
    throw new SyncError('尚未配置 WebDAV 账户，请先在设置页填写并保存', 'NOT_CONFIGURED');
  }
  const password = await resolvePassword(ctx, options.passwordRef);
  if (password === undefined) {
    throw new SyncError(
      `没有找到 WebDAV 密码：请把它保存到 DSH 凭据库的 "${options.passwordRef}" 下（设置页的密码框），或设置同名环境变量`,
      'CREDENTIAL_MISSING',
    );
  }
  let webdav;
  try {
    webdav = await createWebDav({
      baseUrl,
      username: options.username,
      password,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw error instanceof WebDavError ? error : new SyncError(`WebDAV 配置无效: ${error?.message ?? error}`, 'WEBDAV_INVALID_URL');
  }
  return { webdav, dirSegs: remoteDirSegments(options), options };
}

/** 测试连接：PROPFIND 根地址 + 逐级 MKCOL 远端目录。 */
export async function testConnection(ctx, options) {
  const startedAt = Date.now();
  const { webdav, dirSegs } = await openSession(ctx, options);
  await webdav.testConnection();
  await webdav.ensureDirectories(dirSegs);
  return {
    remotePath: `/${dirSegs.join('/')}`,
    latencyMs: Date.now() - startedAt,
  };
}

/** 拉取远端 manifest 摘要（不下载 artifact）。 */
export async function remoteInfo(ctx, options) {
  const { webdav, dirSegs } = await openSession(ctx, options);
  const manifestFile = await webdav.get([...dirSegs, MANIFEST_NAME], MAX_MANIFEST_BYTES);
  if (manifestFile === null) {
    return { exists: false, manifest: null, remotePath: `/${dirSegs.join('/')}` };
  }
  const manifest = parseManifest(manifestFile.bytes);
  return {
    exists: true,
    remotePath: `/${dirSegs.join('/')}`,
    manifest: {
      deviceName: manifest.deviceName,
      createdAt: manifest.createdAt,
      profileName: manifest.profileName,
      snapshotId: manifest.snapshotId,
      fileCount: manifest.fileCount,
      artifacts: Object.fromEntries(Object.entries(manifest.artifacts).map(([key, meta]) => [key, { size: meta.size }])),
    },
  };
}

/**
 * 上传本地快照。
 *
 * 顺序与 CC Switch 一致：artifact 先传、manifest 最后传，这样下载方不会读到
 * 「manifest 已更新但 artifact 还是旧的」的中间态。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} options 配置快照。
 * @returns {Promise<object>} 上传结果。
 */
export async function uploadSnapshot(ctx, options) {
  const startedAt = Date.now();
  const { webdav, dirSegs } = await openSession(ctx, options);
  const profile = resolveProfileInfo(ctx);
  const dshHome = resolveDshHome();
  const snapshot = await buildLocalSnapshot({
    profileDir: profile.dir,
    dshHome,
    profileName: profile.name,
    deviceName: detectDeviceName(),
    dshVersion: '',
    syncCredentials: options.syncCredentials,
    maxPluginBytes: options.maxPluginBytes,
  });

  await webdav.ensureDirectories(dirSegs);
  // 上传前先看远端 manifest：存在但协议不兼容时拒绝覆盖（设计 §2），
  // 避免把未来版本/其它工具的同步数据静默冲掉。
  let existing;
  try {
    existing = await webdav.get([...dirSegs, MANIFEST_NAME], MAX_MANIFEST_BYTES);
  } catch (error) {
    throw new SyncError(
      `读取远端 manifest 失败，为避免覆盖已有数据已中止上传: ${error?.message ?? error}。` +
        '如果远端目录尚不存在，请先在 WebDAV 网页端创建「远程根目录」后重试。',
      'REMOTE_UNREADABLE',
    );
  }
  if (existing !== null) {
    try {
      parseManifest(existing.bytes);
    } catch (error) {
      throw new SyncError(
        `远端已有不兼容的同步数据，为避免覆盖已中止上传。如果确认要覆盖，请先在 WebDAV 上删除 ${dirSegs.join('/')} 目录下的文件。原因: ${error?.message ?? error}`,
        'MANIFEST_INCOMPATIBLE',
      );
    }
  }
  await webdav.put([...dirSegs, ARTIFACT_CONFIG], snapshot.configZip.bytes, 'application/zip');
  await webdav.put([...dirSegs, ARTIFACT_PLUGINS], snapshot.pluginsZip.bytes, 'application/zip');
  await webdav.put([...dirSegs, MANIFEST_NAME], snapshot.manifestBytes, 'application/json');
  const head = await webdav.head([...dirSegs, MANIFEST_NAME]).catch(() => null);

  const now = Math.floor(Date.now() / 1000);
  await patchState(dshHome, {
    lastSyncAt: now,
    lastSuccess: 'upload',
    lastLocalSnapshotId: snapshot.snapshotId,
    lastRemoteSnapshotId: snapshot.snapshotId,
    lastRemoteEtag: head?.etag ?? null,
    lastError: null,
    lastErrorAt: null,
  }).catch(() => {});

  return {
    action: 'upload',
    remotePath: `/${dirSegs.join('/')}`,
    snapshotId: snapshot.snapshotId,
    files: snapshot.manifest.fileCount,
    bytes: snapshot.configZip.size + snapshot.pluginsZip.size,
    plugins: snapshot.packages.length,
    durationMs: Date.now() - startedAt,
    warnings: snapshot.warnings,
  };
}

/**
 * 下载远端快照并应用。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} options 配置快照。
 * @returns {Promise<object>} 下载结果。
 */
export async function downloadSnapshot(ctx, options) {
  const startedAt = Date.now();
  const { webdav, dirSegs } = await openSession(ctx, options);
  const profile = resolveProfileInfo(ctx);
  const dshHome = resolveDshHome();

  const manifestFile = await webdav.get([...dirSegs, MANIFEST_NAME], MAX_MANIFEST_BYTES);
  if (manifestFile === null) {
    throw new SyncError('远端没有可下载的同步数据（manifest.json 不存在）', 'REMOTE_EMPTY');
  }
  let manifest;
  try {
    manifest = parseManifest(manifestFile.bytes);
  } catch (error) {
    throw new SyncError(`远端 manifest 不兼容: ${error?.message ?? error}`, 'MANIFEST_INCOMPATIBLE');
  }

  const configFile = await webdav.get([...dirSegs, ARTIFACT_CONFIG], options.maxArtifactBytes);
  if (configFile === null) {
    throw new SyncError(`远端缺少 ${ARTIFACT_CONFIG}`, 'REMOTE_MISSING_ARTIFACT');
  }
  verifyArtifact(configFile.bytes, manifest.artifacts[ARTIFACT_CONFIG]);

  const pluginsFile = await webdav.get([...dirSegs, ARTIFACT_PLUGINS], options.maxArtifactBytes);
  if (pluginsFile === null) {
    throw new SyncError(`远端缺少 ${ARTIFACT_PLUGINS}`, 'REMOTE_MISSING_ARTIFACT');
  }
  verifyArtifact(pluginsFile.bytes, manifest.artifacts[ARTIFACT_PLUGINS]);

  const configEntries = zipRead(configFile.bytes);
  const pluginEntries = zipRead(pluginsFile.bytes);
  const pluginList = readPluginList(pluginEntries);
  // 插件恢复目标只能来自「下载前」的本地 profile 依赖声明（远端快照里的
  // package.json / _plugins.json 都是远端可控数据，不能决定写入位置）。
  const trustedDependencies = await readTrustedLocalDependencies(profile.dir);
  let applied;
  try {
    applied = await applySnapshot({
      configEntries,
      pluginEntries,
      pluginList,
      trustedDependencies,
      allowCredentials: options.syncCredentials,
      profileDir: profile.dir,
      dshHome,
      backupsRoot: backupsRoot(dshHome),
      backupKeep: options.backupKeep,
    });
  } catch (error) {
    if (error instanceof ApplyError) {
      error.message = `${error.message}（已覆盖文件的备份在 ${backupsRoot(dshHome)}）`;
    }
    throw error;
  }

  // 下载后重建本地快照，记录「恢复后本地内容」的真实 id。
  // 跨机恢复（插件目录回退到 profile 内、依赖被改写）会让本地快照与远端不同；
  // 此时若仍把远端 id 当成 lastLocalSnapshotId，自动同步会立刻上传本机适配版
  // 覆盖远端。重建失败就退化为远端 id（并只在日志里提示）。
  let localSnapshotId = manifest.snapshotId;
  try {
    const rebuilt = await buildLocalSnapshot({
      profileDir: profile.dir,
      dshHome,
      profileName: profile.name,
      deviceName: detectDeviceName(),
      dshVersion: '',
      syncCredentials: options.syncCredentials,
      maxPluginBytes: options.maxPluginBytes,
    });
    localSnapshotId = rebuilt.snapshotId;
  } catch (error) {
    ctx.logger?.warn?.(`[webdav-sync] 下载后重建本地快照失败，自动同步可能误判一次: ${error?.message ?? error}`);
  }

  const now = Math.floor(Date.now() / 1000);
  await patchState(dshHome, {
    lastSyncAt: now,
    lastSuccess: 'download',
    lastLocalSnapshotId: localSnapshotId,
    lastRemoteSnapshotId: manifest.snapshotId,
    lastRemoteEtag: manifestFile.etag ?? null,
    lastError: null,
    lastErrorAt: null,
  }).catch(() => {});

  // 跨机恢复时插件会回退到 profile 内 `plugins/<包名>` 并改写依赖；DSH 还需要一次
  // 依赖安装才会把这些包链接进 node_modules，否则插件管理器会报「包不可用」。
  // 这里自动跑一次安装（profile + 每个回退插件目录），失败时把命令带回给界面。
  const fallbackPlugins = applied.plugins.filter((plugin) => plugin.fallback === true).map((plugin) => plugin.name);
  const requiresInstall = fallbackPlugins.length > 0;
  const installHint = requiresInstall
    ? `dsh plugin --profile ${profile.name} install`
    : '';
  let install = { attempted: false, ok: false, results: [] };
  if (requiresInstall) {
    const pluginDirs = applied.plugins.filter((plugin) => plugin.fallback === true).map((plugin) => plugin.dir);
    install = await installFallbackDependencies(ctx, { profileDir: profile.dir, pluginDirs });
  }

  return {
    action: 'download',
    remotePath: `/${dirSegs.join('/')}`,
    snapshotId: manifest.snapshotId,
    localSnapshotId,
    adapted: localSnapshotId !== manifest.snapshotId,
    deviceName: manifest.deviceName,
    createdAt: manifest.createdAt,
    files: manifest.fileCount,
    bytes: configFile.bytes.length + pluginsFile.bytes.length,
    durationMs: Date.now() - startedAt,
    backupDir: applied.backupDir,
    backedUp: applied.backedUp,
    written: applied.written,
    plugins: applied.plugins,
    fallbackPlugins,
    requiresInstall,
    installHint,
    install,
    warnings: [...applied.warnings],
    requiresRestart: true,
  };
}

// ─── 状态汇总 ────────────────────────────────────────────────

/**
 * 设置页轮询的状态快照。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} config 行配置。
 * @param {object} runtime 运行时状态（busy 标记）。
 * @returns {Promise<object>}
 */
export async function buildStatus(ctx, config, runtime) {
  const options = resolveOptions(ctx, config);
  const profile = resolveProfileInfo(ctx);
  const dshHome = resolveDshHome();
  const state = await readState(dshHome);
  const passwordConfigured = (await resolvePassword(ctx, options.passwordRef).catch(() => undefined)) !== undefined;
  // 下发给界面的 baseUrl 是「实际生效值」：显式地址优先，否则由服务商预设推导。
  const baseUrl = resolveBaseUrl(options);
  return {
    version: PLUGIN_VERSION,
    configured: isNonEmptyString(baseUrl) && isNonEmptyString(options.username) && passwordConfigured,
    busy: runtime?.busy === true,
    remotePath: remoteDirDisplay(options),
    platform: {
      dshHome,
      profileDir: profile.dir,
      profileName: profile.name,
    },
    config: {
      provider: options.provider,
      providerPreset: options.providerPreset,
      baseUrl,
      baseUrlFromPreset: !isNonEmptyString(options.baseUrl) && baseUrl.length > 0,
      username: options.username,
      remoteRoot: options.remoteRoot,
      syncProfile: options.syncProfile,
      autoSync: options.autoSync,
      syncCredentials: options.syncCredentials,
      passwordConfigured,
    },
    state: {
      lastSyncAt: Number.isFinite(state.lastSyncAt) ? state.lastSyncAt : null,
      lastSuccess: typeof state.lastSuccess === 'string' ? state.lastSuccess : null,
      lastError: typeof state.lastError === 'string' ? state.lastError : null,
      lastErrorAt: Number.isFinite(state.lastErrorAt) ? state.lastErrorAt : null,
      lastLocalSnapshotId: typeof state.lastLocalSnapshotId === 'string' ? state.lastLocalSnapshotId : null,
      lastRemoteSnapshotId: typeof state.lastRemoteSnapshotId === 'string' ? state.lastRemoteSnapshotId : null,
    },
  };
}

// ─── RPC ─────────────────────────────────────────────────────

/** 成功信封。 */
function ok(value) {
  return { ok: true, value };
}

/** 失败信封：`details` 必须是对象，这是 Connection 客户端的硬要求。 */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

/**
 * 构造 Connection RPC handler。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} config 行配置。
 * @param {object} runtime 运行时状态。
 * @returns {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<object>}
 */
export function createRpcHandler(ctx, config, runtime) {
  const guard = async (operation) => {
    if (runtime.busy) return fail('BUSY', '另一个同步操作正在进行，请稍后再试');
    runtime.busy = true;
    try {
      return ok(await operation());
    } finally {
      runtime.busy = false;
    }
  };

  return async (endpoint, payload, signal) => {
    if (signal?.aborted === true) return fail('ABORTED', '请求已取消');
    try {
      const options = resolveOptions(ctx, config);
      switch (endpoint) {
        case 'status':
          return ok(await buildStatus(ctx, config, runtime));
        case 'remote':
          return await guard(() => remoteInfo(ctx, options));
        case 'test':
          return await guard(() => testConnection(ctx, options));
        case 'upload':
          return await guard(() => uploadSnapshot(ctx, options));
        case 'download':
          return await guard(() => downloadSnapshot(ctx, options));
        default:
          return fail('UNKNOWN_ENDPOINT', `未知的同步端点: ${endpoint}`);
      }
    } catch (error) {
      const publicError = toPublicError(error);
      if (endpoint !== 'status') {
        // 状态写入或日志失败绝不能吞掉真正的错误响应。
        try {
          const dshHome = resolveDshHome();
          await patchState(dshHome, {
            lastError: publicError.message,
            lastErrorAt: Math.floor(Date.now() / 1000),
            lastErrorSource: endpoint,
          });
        } catch {
          // 忽略
        }
        try {
          ctx.logger?.warn?.(`[webdav-sync] ${endpoint} 失败: ${publicError.message}`);
        } catch {
          // 忽略
        }
      }
      return fail(publicError.code, publicError.message);
    }
  };
}

// ─── 自动同步 ────────────────────────────────────────────────

/** 参与自动同步的 profile 文件名集合（含 profile 内插件目录前缀）。 */
const WATCHED_PROFILE_FILES = new Set(PROFILE_CONFIG_FILES);

/**
 * 判断某个被监听的文件名是否值得触发一次同步。
 *
 * @param {string | undefined} filename fs.watch 给出的相对路径。
 * @param {'profile' | 'home'} scope 监听范围。
 * @returns {boolean}
 */
export function shouldTriggerForPath(filename, scope) {
  if (typeof filename !== 'string' || filename.length === 0) return false;
  const normalized = filename.replace(/\\/gu, '/');
  if (normalized.startsWith('node_modules') || normalized.startsWith('.plugin-manager')) return false;
  if (scope === 'home') {
    return HOME_CONFIG_FILES.includes(normalized);
  }
  if (WATCHED_PROFILE_FILES.has(normalized)) return true;
  // profile 内的插件目录（下载回退时写入这里）
  return normalized.startsWith('plugins/');
}

/**
 * 自动同步：监听 + debounce + 兜底轮询。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} config 行配置。
 * @param {object} runtime 运行时状态。
 * @returns {() => void} 清理函数。
 */
export function startAutoSync(ctx, config, runtime) {
  const profile = resolveProfileInfo(ctx);
  const dshHome = resolveDshHome();
  const disposers = [];
  let timer = null;
  let deadline = 0;
  let disposed = false;
  let lastAttemptSnapshotId = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const runOnce = async () => {
    timer = null;
    if (disposed) return;
    const options = resolveOptions(ctx, config);
    if (!options.autoSync) return;
    // 配置还不完整时保持静默：不能把「用户还没填 WebDAV」写成一条自动同步错误。
    if (!isNonEmptyString(options.baseUrl) || !isNonEmptyString(options.username)) return;
    if ((await resolvePassword(ctx, options.passwordRef).catch(() => undefined)) === undefined) return;
    if (runtime.busy) {
      // 手动操作进行中：稍后再试，但不无限循环
      schedule();
      return;
    }
    // 自动上传与手动操作共享 busy 标记，避免两路 uploadSnapshot 交错 PUT。
    runtime.busy = true;
    try {
      const state = await readState(dshHome);
      const snapshot = await buildLocalSnapshot({
        profileDir: profile.dir,
        dshHome,
        profileName: profile.name,
        deviceName: detectDeviceName(),
        dshVersion: '',
        syncCredentials: options.syncCredentials,
        maxPluginBytes: options.maxPluginBytes,
      });
      if (snapshot.warnings.length > 0) {
        for (const warning of snapshot.warnings) ctx.logger?.debug?.(`[webdav-sync] 自动同步: ${warning}`);
      }
      if (lastAttemptSnapshotId === snapshot.snapshotId) return;
      if (state.lastLocalSnapshotId === snapshot.snapshotId) return; // 与上次成功同步一致
      lastAttemptSnapshotId = snapshot.snapshotId;
      const result = await uploadSnapshot(ctx, options);
      ctx.logger?.info?.(`[webdav-sync] 自动同步已上传 ${result.files} 个文件（snapshot ${String(result.snapshotId).slice(0, 8)}）`);
    } catch (error) {
      lastAttemptSnapshotId = null; // 失败后允许下一轮轮询重试（60s 轮询天然限流）
      const publicError = toPublicError(error);
      ctx.logger?.warn?.(`[webdav-sync] 自动同步失败: ${publicError.message}`);
      await patchState(dshHome, {
        lastError: `自动同步失败: ${publicError.message}`,
        lastErrorAt: Math.floor(Date.now() / 1000),
        lastErrorSource: 'auto',
      }).catch(() => {});
    } finally {
      runtime.busy = false;
    }
  };

  const schedule = () => {
    if (disposed) return;
    const now = Date.now();
    if (deadline === 0) deadline = now + AUTO_SYNC_MAX_WAIT_MS;
    clearTimer();
    // 每次事件重置 debounce 定时器；但连续事件最多合并到 deadline 为止。
    const wait = Math.max(0, Math.min(AUTO_SYNC_DEBOUNCE_MS, deadline - now));
    timer = setTimeout(() => {
      deadline = 0;
      void runOnce();
    }, wait);
  };

  const watchDirectory = (dir, scope) => {
    try {
      const watcher = watch(dir, { recursive: scope === 'profile' }, (eventType, filename) => {
        if (shouldTriggerForPath(filename ?? undefined, scope)) schedule();
      });
      watcher.on('error', (error) => ctx.logger?.debug?.(`[webdav-sync] 目录监听失败 ${dir}: ${error?.message ?? error}`));
      disposers.push(() => watcher.close());
    } catch (error) {
      ctx.logger?.debug?.(`[webdav-sync] 无法监听 ${dir}: ${error?.message ?? error}`);
    }
  };

  watchDirectory(profile.dir, 'profile');
  watchDirectory(dshHome, 'home');

  const poll = setInterval(() => schedule(), AUTO_SYNC_POLL_MS);
  disposers.push(() => clearInterval(poll));

  return () => {
    disposed = true;
    clearTimer();
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 清理失败不致命
      }
    }
  };
}

// ─── 调试诊断 ────────────────────────────────────────────────

/**
 * 把一行诊断信息追加到 `$DSH_HOME/webdav-sync/diag.log`。
 *
 * DSH 桌面版的 Host logger 输出不一定落盘，而「RPC 路由没注册」这类问题在界面上
 * 只表现为 HTTP 405，排查时需要一个确定可见的落点。这里只写纯文本、不写凭据。
 *
 * @param {string} line 诊断行。
 */
export async function appendDiagnostic(line) {
  try {
    const dir = syncDataDir(resolveDshHome());
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'diag.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // 诊断日志失败不影响功能
  }
}

// ─── RPC 通道安装 ────────────────────────────────────────────

/** RPC 请求体上限：动作请求只是几个 JSON 字段，64 KiB 足够。 */
const MAX_RPC_BODY_BYTES = 64 * 1024;

/**
 * 在 Host 的 web server 上注册浏览器半使用的 RPC 通道。
 *
 * 为什么不用 `ctx.connection.rpc.handle()`：它注册时执行
 * `owner.effect(() => owner.webServer.register(route))`，其中 owner 是调用方
 * fiber 的 ctx；调用方没有同时 inject `webServer` 时，这次属性访问会抛
 * `"cannot get property \"webServer\" without inject"`，表现为客户端拿到
 * **HTTP 405**（请求落到 SPA fallback）。这里显式注册 prefix 路由，并复用
 * Connection 的公开认证入口 `admit()`，请求/响应信封与官方 RPC carrier 一致。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} config 行配置。
 * @param {object} runtime 运行时状态。
 * @returns {void}
 */
export function installRpcChannel(ctx, config, runtime) {
  const handler = createRpcHandler(ctx, config, runtime);
  ctx.inject?.(['connection', 'webServer'], (rpcCtx) => {
    rpcCtx.effect(() => {
      const connection = rpcCtx.connection;
      const webServer = rpcCtx.webServer;
      if (connection === undefined || webServer === undefined) {
        void appendDiagnostic('[rpc] connection 或 webServer 服务不可用，跳过 RPC 通道注册');
        return () => {};
      }
      try {
        const dispose = webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler: async (req, res) => {
            let admission;
            try {
              admission = connection.admit(req);
            } catch (error) {
              res.writeHead(500);
              res.end(`admission failed: ${String(error)}`);
              return;
            }
            if ('rejection' in admission) {
              res.writeHead(admission.rejection);
              res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
              return;
            }
            if (req.method !== 'POST') {
              res.writeHead(404);
              res.end('not found');
              return;
            }
            const chunks = [];
            try {
              for await (const chunk of req) chunks.push(chunk);
            } catch {
              res.writeHead(400);
              res.end('request body unreadable');
              return;
            }
            const raw = Buffer.concat(chunks);
            if (raw.length > MAX_RPC_BODY_BYTES) {
              res.writeHead(413);
              res.end('request body too large');
              return;
            }
            let request;
            try {
              request = JSON.parse(raw.toString('utf8'));
            } catch {
              res.writeHead(400);
              res.end('body is not JSON');
              return;
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const endpoint = url.pathname.startsWith(`${RPC_CHANNEL}/`)
              ? url.pathname.slice(RPC_CHANNEL.length + 1)
              : '';
            const controller = new AbortController();
            req.on('close', () => controller.abort());
            let result;
            try {
              result = await handler(
                String(request?.method ?? endpoint),
                request?.payload,
                controller.signal,
                admission.peer,
              );
            } catch (error) {
              res.writeHead(500);
              res.end(`handler failure: ${String(error)}`);
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'server-response', rpcId: request?.rpcId, result }));
          },
        });
        void appendDiagnostic(`[rpc] 已注册 prefix 路由 ${RPC_CHANNEL}`);
        return dispose;
      } catch (error) {
        void appendDiagnostic(`[rpc] webServer.register 失败: ${error?.message ?? error}`);
        // 回退到官方通道（若该部署的 rpc.handle 可用）。
        try {
          return connection.rpc.handle(RPC_CHANNEL, handler);
        } catch (fallbackError) {
          void appendDiagnostic(`[rpc] rpc.handle 回退也失败: ${fallbackError?.message ?? fallbackError}`);
          return () => {};
        }
      }
    }, 'webdav-sync: rpc channel');
  });
}

/**
 * 安装插件：设置页策略、RPC 通道、自动同步。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} config 行配置。
 */
export function apply(ctx, config) {
  const runtime = { busy: false };

  // 设置页由 client.js 自己画，关掉自动生成页。
  ctx.inject?.(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'webdav-sync: settings presentation policy',
    );
  });

  // 浏览器半的 RPC 通道（见 installRpcChannel 的注释：必须同时 inject webServer）。
  installRpcChannel(ctx, config, runtime);

  // 自动同步（配置变化上传）。
  ctx.effect(() => startAutoSync(ctx, config, runtime), 'webdav-sync: auto sync');

  ctx.logger?.debug?.('[webdav-sync] 已加载');
}
