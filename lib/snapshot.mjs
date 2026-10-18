/**
 * 同步快照协议：sha256、snapshotId、manifest 构建与校验、文件读取、ZIP artifact 构建。
 *
 * 协议形态（设计文档 §6）：
 * - 本地把配置与插件分别打成 `config.zip` / `plugins.zip`；
 * - manifest 记录两个 artifact 的 sha256/size、设备名、DSH 版本、快照文件数与 snapshotId；
 * - snapshotId = sha256(`config.zip:<sha>|plugins.zip:<sha>`)，用于判断两端是否一致。
 *
 * manifest 的格式 / 协议版本不匹配时必须抛错（绝不覆盖远端），所以
 * `parseManifest` 把兼容性校验放在最前面。
 *
 * @module dsh-webdav-sync/lib/snapshot
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { zipWrite } from './zip.mjs';

/** 远端 manifest 的格式标识。 */
export const PROTOCOL_FORMAT = 'dsh-webdav-sync';
/** 协议版本；读到其它版本必须拒绝。 */
export const PROTOCOL_VERSION = 1;
/** 配置 artifact 名。 */
export const ARTIFACT_CONFIG = 'config.zip';
/** 插件 artifact 名。 */
export const ARTIFACT_PLUGINS = 'plugins.zip';
/** manifest 文件名。 */
export const MANIFEST_NAME = 'manifest.json';
/** 设备名缺失时的兜底值。 */
export const DEFAULT_DEVICE_NAME = 'Unknown Device';
/** 设备名最大长度（按 Unicode 码点计）。 */
export const MAX_DEVICE_NAME_LEN = 64;

/** artifact 的固定顺序：snapshotId 的哈希输入与 manifest 字段顺序都依赖它。 */
const ARTIFACT_ORDER = [ARTIFACT_CONFIG, ARTIFACT_PLUGINS];

/** 读取文件时每批并发数，避免一次性打开上千个文件触发 EMFILE。 */
const READ_CONCURRENCY = 32;

/** 64 位十六进制 sha256 的正则。 */
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/u;

// ─── 哈希与 snapshotId ──────────────────────────────────────

/**
 * 计算字节串的 SHA-256（小写 hex）。字符串按 UTF-8 处理。
 * @param {Uint8Array|ArrayBuffer|string} bytes
 * @returns {string}
 */
export function sha256Hex(bytes) {
  let input;
  if (typeof bytes === 'string') input = bytes;
  else if (bytes instanceof Uint8Array) input = bytes;
  else if (ArrayBuffer.isView(bytes)) {
    input = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else if (bytes instanceof ArrayBuffer) input = new Uint8Array(bytes);
  else throw new TypeError('sha256Hex 的入参必须是 Uint8Array/Buffer/ArrayBuffer/字符串');
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 校验 artifact 元数据里的 sha256，返回小写形式。
 * @param {unknown} raw
 * @param {string} name artifact 名（用于错误信息）
 * @returns {string}
 */
function normalizeSha256(raw, name) {
  if (typeof raw !== 'string' || !SHA256_PATTERN.test(raw)) {
    throw new Error(`artifact ${name} 的 sha256 不合法（应为 64 位十六进制字符串）`);
  }
  return raw.toLowerCase();
}

/**
 * 校验并规范化单个 artifact 的元数据。
 * @param {unknown} meta
 * @param {string} name
 * @returns {{sha256: string, size: number}}
 */
function normalizeArtifactMeta(meta, name) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error(`artifact ${name} 的元数据必须是对象`);
  }
  const sha256 = normalizeSha256(meta.sha256, name);
  if (!Number.isInteger(meta.size) || meta.size < 0) {
    throw new Error(`artifact ${name} 的 size 必须是非负整数`);
  }
  return { sha256, size: meta.size };
}

/**
 * 由 artifact 哈希计算快照标识：sha256("config.zip:<sha>|plugins.zip:<sha>")。
 *
 * @param {Record<string, {sha256: string, size: number}>} artifacts
 * @returns {string}
 */
export function computeSnapshotId(artifacts) {
  if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new TypeError('computeSnapshotId 的 artifacts 必须是对象');
  }
  const parts = [];
  for (const name of ARTIFACT_ORDER) {
    const meta = artifacts[name];
    if (meta === undefined) {
      throw new Error(`computeSnapshotId 缺少 artifact：${name}`);
    }
    parts.push(`${name}:${normalizeSha256(meta.sha256, name)}`);
  }
  return sha256Hex(parts.join('|'));
}

// ─── 文件读取与 ZIP artifact ────────────────────────────────

/**
 * 读取一组本地文件，计算各自的 sha256 与大小。
 *
 * @param {Array<{path: string, absPath: string}>} entries
 *   `path` 是 zip 内相对路径（正斜杠），`absPath` 是磁盘绝对路径。
 * @returns {Promise<Array<{path: string, sha256: string, size: number, bytes: Uint8Array}>>}
 *   顺序与入参一致。
 */
export async function readFileEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('readFileEntries 的 entries 必须是数组');
  }

  const results = new Array(entries.length);
  for (let start = 0; start < entries.length; start += READ_CONCURRENCY) {
    const batch = entries.slice(start, start + READ_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (entry, offset) => {
        const index = start + offset;
        if (entry === null || typeof entry !== 'object') {
          throw new TypeError(`readFileEntries 第 ${index + 1} 项必须是对象`);
        }
        const zipPath = normalizeRelativeZipPath(entry.path);
        if (typeof entry.absPath !== 'string' || entry.absPath.trim() === '') {
          throw new TypeError(`readFileEntries 第 ${index + 1} 项缺少 absPath`);
        }
        let bytes;
        try {
          bytes = await readFile(entry.absPath);
        } catch (error) {
          throw new Error(`读取文件失败（${zipPath}）：${error.message}`, { cause: error });
        }
        return { path: zipPath, sha256: sha256Hex(bytes), size: bytes.length, bytes };
      }),
    );
    for (let offset = 0; offset < batchResults.length; offset += 1) {
      results[start + offset] = batchResults[offset];
    }
  }
  return results;
}

/**
 * 把文件列表打成确定性的 ZIP artifact。
 *
 * 顺序由 `zipWrite` 内部按路径字典序排序保证，因此同一组文件无论传入顺序
 * 如何，得到的 bytes / sha256 / size 都完全一致（快照可复现的前提）。
 *
 * @param {Array<{path: string, bytes: Uint8Array|Buffer}>} files
 * @returns {{bytes: Uint8Array, sha256: string, size: number}}
 */
export function buildZipArtifact(files) {
  if (!Array.isArray(files)) {
    throw new TypeError('buildZipArtifact 的 files 必须是数组');
  }
  const entries = files.map((file, index) => {
    if (file === null || typeof file !== 'object') {
      throw new TypeError(`buildZipArtifact 第 ${index + 1} 项必须是对象`);
    }
    if (!(file.bytes instanceof Uint8Array)) {
      throw new TypeError(`buildZipArtifact 第 ${index + 1} 项的 bytes 必须是 Uint8Array 或 Buffer`);
    }
    return { name: normalizeRelativeZipPath(file.path), bytes: file.bytes };
  });
  const bytes = zipWrite(entries);
  return { bytes, sha256: sha256Hex(bytes), size: bytes.length };
}

// ─── manifest ───────────────────────────────────────────────

/**
 * 构建 manifest 及其 JSON 字节。
 *
 * @param {{
 *   artifacts: Record<string, {sha256: string, size: number}>,
 *   deviceName?: string,
 *   dshVersion?: string,
 *   profileName?: string,
 *   fileCount?: number,
 * }} params
 * @returns {{manifest: object, bytes: Uint8Array, sha256: string}}
 */
export function buildManifest({ artifacts, deviceName, dshVersion, profileName, fileCount } = {}) {
  if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new TypeError('buildManifest 的 artifacts 必须是对象');
  }
  const normalizedArtifacts = {};
  for (const name of ARTIFACT_ORDER) {
    const meta = artifacts[name];
    if (meta === undefined) {
      throw new Error(`buildManifest 缺少 artifact：${name}`);
    }
    normalizedArtifacts[name] = normalizeArtifactMeta(meta, name);
  }

  const manifest = {
    format: PROTOCOL_FORMAT,
    protocolVersion: PROTOCOL_VERSION,
    deviceName: normalizeDeviceName(deviceName),
    createdAt: new Date().toISOString(),
    dshVersion: typeof dshVersion === 'string' ? dshVersion : '',
    profileName: typeof profileName === 'string' ? profileName : '',
    artifacts: normalizedArtifacts,
    fileCount: Number.isInteger(fileCount) && fileCount >= 0 ? fileCount : 0,
    snapshotId: computeSnapshotId(normalizedArtifacts),
  };
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  return { manifest, bytes, sha256: sha256Hex(bytes) };
}

/**
 * 解析并校验远端 manifest。
 *
 * 校验项：JSON 对象、format、protocolVersion、两个 artifact 的 {sha256, size} 形状。
 * 任何不合法都会抛错（调用方不得覆盖远端）。
 *
 * @param {Uint8Array|Buffer|ArrayBuffer|string} input
 * @returns {object} 规范化后的 manifest（sha256 小写、缺失的 snapshotId 会被补算）
 */
export function parseManifest(input) {
  let text;
  if (typeof input === 'string') {
    text = input;
  } else if (input instanceof Uint8Array) {
    text = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8');
  } else if (input instanceof ArrayBuffer) {
    text = Buffer.from(input).toString('utf8');
  } else {
    throw new TypeError('parseManifest 的入参必须是字符串、Uint8Array 或 ArrayBuffer');
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`远端 manifest 不是合法 JSON：${error.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('远端 manifest 必须是 JSON 对象');
  }
  if (raw.format !== PROTOCOL_FORMAT) {
    throw new Error(
      `远端 manifest 格式不兼容：期望 "${PROTOCOL_FORMAT}"，实际 ${JSON.stringify(raw.format)}`,
    );
  }
  if (raw.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `远端 manifest 协议版本不兼容：期望 v${PROTOCOL_VERSION}，实际 ${JSON.stringify(raw.protocolVersion)}`,
    );
  }
  if (raw.artifacts === null || typeof raw.artifacts !== 'object' || Array.isArray(raw.artifacts)) {
    throw new Error('远端 manifest 缺少 artifacts 对象');
  }

  const artifacts = {};
  for (const name of ARTIFACT_ORDER) {
    const meta = raw.artifacts[name];
    if (meta === undefined) {
      throw new Error(`远端 manifest 缺少 artifact：${name}`);
    }
    artifacts[name] = normalizeArtifactMeta(meta, name);
  }

  return {
    ...raw,
    deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : normalizeDeviceName(raw.deviceName),
    artifacts,
    snapshotId:
      typeof raw.snapshotId === 'string' && raw.snapshotId !== ''
        ? raw.snapshotId
        : computeSnapshotId(artifacts),
  };
}

/**
 * 校验下载到的 artifact 字节与 manifest 记录一致（先比 size 再比 sha256）。
 * @param {Uint8Array|Buffer} bytes
 * @param {{sha256: string, size: number}} meta
 * @returns {void}
 */
export function verifyArtifact(bytes, meta) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('verifyArtifact 的 bytes 必须是 Uint8Array 或 Buffer');
  }
  if (meta === null || typeof meta !== 'object') {
    throw new TypeError('verifyArtifact 的 meta 必须是对象');
  }
  if (!Number.isInteger(meta.size) || meta.size < 0) {
    throw new Error('verifyArtifact 的 meta.size 必须是非负整数');
  }
  if (typeof meta.sha256 !== 'string' || !SHA256_PATTERN.test(meta.sha256)) {
    throw new Error('verifyArtifact 的 meta.sha256 必须是 64 位十六进制字符串');
  }

  if (bytes.length !== meta.size) {
    throw new Error(`artifact 大小不匹配：期望 ${meta.size} 字节，实际 ${bytes.length} 字节`);
  }
  const expected = meta.sha256.toLowerCase();
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(
      `artifact SHA256 校验失败：期望 ${expected.slice(0, 8)}…，实际 ${actual.slice(0, 8)}…`,
    );
  }
}

// ─── 字符串 / 路径规范化 ────────────────────────────────────

/**
 * 规范化设备名：空白折叠为单个空格、去掉控制字符、截断到 64 个码点。
 * 空值返回 `'Unknown Device'`。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeDeviceName(raw) {
  if (typeof raw !== 'string') return DEFAULT_DEVICE_NAME;

  let cleaned = '';
  for (const char of raw) {
    if (/\s/u.test(char)) {
      cleaned += ' ';
    } else if (/\p{Cc}/u.test(char)) {
      // 控制字符直接丢弃（与参考实现一致）。
    } else {
      cleaned += char;
    }
  }
  const collapsed = cleaned
    .split(/\s+/u)
    .filter((part) => part !== '')
    .join(' ');
  const limited = Array.from(collapsed).slice(0, MAX_DEVICE_NAME_LEN).join('');
  return limited === '' ? DEFAULT_DEVICE_NAME : limited;
}

/**
 * 规范化 zip 内相对路径：统一正斜杠、去掉前导 `/`、折叠空段与 `./`、
 * 拒绝任何 `..` 段（路径遍历）与盘符绝对路径。
 *
 * @param {unknown} path
 * @returns {string} 例如 `plugins/foo/index.js`
 */
export function normalizeRelativeZipPath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('ZIP 路径不能为空');
  }
  const posix = path.trim().replace(/\\/gu, '/');
  const segments = [];
  for (const segment of posix.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new Error(`ZIP 路径不能包含 ".."（路径遍历）：${path}`);
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new Error(`ZIP 路径不能为空：${path}`);
  }
  const normalized = segments.join('/');
  if (/^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`ZIP 路径不能是盘符绝对路径：${path}`);
  }
  return normalized;
}
