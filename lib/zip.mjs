/**
 * 纯 Node.js 的 ZIP 读写（store / deflate），零第三方依赖。
 *
 * 只实现同步场景需要的那一小块 ZIP：普通文件条目、UTF-8 文件名、CRC32 校验、
 * 路径遍历防护。刻意不支持 ZIP64、加密、分卷、数据描述符。
 *
 * 两条设计约束（由快照协议决定）：
 * 1. **字节级确定性**：条目先按 name 字典序排序，DOS 修改时间统一写死为
 *    1980-01-01 00:00:00。这样同一组文件无论读取顺序如何、无论打包几次，
 *    都会得到完全相同的字节，进而得到相同的 sha256 / snapshotId。
 *    传入的 `mtime` 字段仅为兼容接口而接受，不会写进 zip。
 * 2. **防路径遍历 / 压缩炸弹**：写入与读取两侧都校验条目名，读取侧限制
 *    单条目与总解压体积。
 *
 * @module dsh-webdav-sync/lib/zip
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** 本地文件头签名。 */
const SIG_LOCAL = 0x04034b50;
/** 中央目录项签名。 */
const SIG_CENTRAL = 0x02014b50;
/** 目录结尾（EOCD）签名。 */
const SIG_EOCD = 0x06054b50;
/** general purpose bit 11：文件名是 UTF-8。 */
const FLAG_UTF8 = 0x0800;
/** general purpose bit 0：加密。 */
const FLAG_ENCRYPTED = 0x0001;
/** 普通文件需要的 ZIP 版本（2.0）。 */
const VERSION_NEEDED = 20;
/** 中央目录里 "version made by"：Unix(3) + 2.0，配合 external attributes 的 0644。 */
const VERSION_MADE_BY = 0x0314;
/** 文件权限 0644，写在 central directory 的 external attributes 高 16 位。 */
const FILE_ATTRS = (0o100644 << 16) >>> 0;
/** DOS 时间下限 1980-01-01 00:00:00 对应的 DOS 字段（本次固定使用）。 */
const DOS_DATE_1980 = 0x0021;
const DOS_TIME_1980 = 0x0000;
/** 单条目解压后上限（防压缩炸弹）。 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
/** 整个 ZIP 解压后总量上限（防压缩炸弹）。 */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

// ─── CRC32 ───────────────────────────────────────────────────

/** CRC32（IEEE 802.3）查表。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32。
 * @param {Uint8Array} bytes
 * @returns {number} 无符号 32 位整数
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── 二进制读写小工具 ────────────────────────────────────────

/**
 * 把入参统一成 Buffer 视图（不拷贝内容）。
 * @param {Uint8Array|ArrayBuffer} value
 * @param {string} label 出错时用于提示的字段名
 * @returns {Buffer}
 */
function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError(`${label} 必须是 Uint8Array 或 Buffer`);
}

function readU16(buf, offset) {
  return buf.readUInt16LE(offset);
}

function readU32(buf, offset) {
  return buf.readUInt32LE(offset);
}

function writeU16(buf, offset, value) {
  buf.writeUInt16LE(value & 0xffff, offset);
}

function writeU32(buf, offset, value) {
  buf.writeUInt32LE(value >>> 0, offset);
}

function hex8(value) {
  return (value >>> 0).toString(16).padStart(8, '0');
}

// ─── 条目名校验 ──────────────────────────────────────────────

/**
 * 校验并规范化「写入侧」条目名：必须是正斜杠相对路径。
 *
 * @param {unknown} rawName
 * @param {number} index 条目下标（只用于错误信息）
 * @returns {string}
 */
function normalizeEntryNameForWrite(rawName, index) {
  if (typeof rawName !== 'string') {
    throw new TypeError(`zipWrite 第 ${index + 1} 个条目的 name 必须是字符串`);
  }
  if (rawName.trim() === '') {
    throw new Error('ZIP 条目名不能为空');
  }
  if (rawName.includes('\\')) {
    throw new Error(`ZIP 条目名不能包含反斜杠（请使用正斜杠）：${rawName}`);
  }
  if (rawName.startsWith('/')) {
    throw new Error(`ZIP 条目名不能是绝对路径：${rawName}`);
  }
  if (/^[A-Za-z]:/.test(rawName)) {
    throw new Error(`ZIP 条目名不能是盘符绝对路径：${rawName}`);
  }
  if (rawName.endsWith('/')) {
    throw new Error(`zipWrite 只写文件条目，条目名不能以 / 结尾：${rawName}`);
  }
  for (const segment of rawName.split('/')) {
    if (segment === '..') {
      throw new Error(`ZIP 条目名不能包含 ".."（路径遍历）：${rawName}`);
    }
    if (segment === '' || segment === '.') {
      throw new Error(`ZIP 条目名包含非法的空段或 "." 段：${rawName}`);
    }
  }
  if (Buffer.byteLength(rawName, 'utf8') > 0xffff) {
    throw new Error(`ZIP 条目名过长（UTF-8 超过 65535 字节）：${rawName}`);
  }
  return rawName;
}

/**
 * 校验「读取侧」条目名，返回原样名字；目录条目返回 null（调用方忽略）。
 *
 * 读取侧比写入侧更严格：任何可疑路径都直接抛错，而不是悄悄跳过，
 * 因为远端 zip 可能来自别的设备或攻击者。
 *
 * @param {string} name
 * @returns {string|null}
 */
function normalizeEntryNameForRead(name) {
  if (name === '') {
    throw new Error('ZIP 条目名为空，文件可能已损坏');
  }
  if (name.includes('\\')) {
    throw new Error(`ZIP 条目名包含反斜杠，拒绝可疑路径：${name}`);
  }
  if (name.startsWith('/')) {
    throw new Error(`ZIP 条目名是绝对路径，拒绝可疑路径：${name}`);
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new Error(`ZIP 条目名是盘符绝对路径，拒绝可疑路径：${name}`);
  }
  const segments = name.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(`ZIP 条目名包含 ".."，拒绝路径遍历：${name}`);
    }
    if (segment === '' || segment === '.') {
      // 目录条目以 / 结尾时最后一段才是空，单独放行；中间的空段一律拒绝。
      if (!(segment === '' && name.endsWith('/'))) {
        throw new Error(`ZIP 条目名包含非法空段或 "." 段：${name}`);
      }
    }
  }
  if (name.endsWith('/')) return null; // 目录条目：忽略
  return name;
}

// ─── 写入 ────────────────────────────────────────────────────

/**
 * 把一个文件条目打包成 ZIP。
 *
 * 结果确定：条目按 name 字典序排序；DOS 修改时间固定为 1980-01-01；
 * store 与 deflate 自动选更小者；文件名统一 UTF-8（bit 11）。
 *
 * @param {Array<{name: string, bytes: Uint8Array|Buffer, mtime?: number|Date}>} entries
 *   `name` 是 zip 内相对路径（正斜杠）。`mtime` 仅为兼容接口而接受：为了保证
 *   字节级确定性，它不会被写入 zip。
 * @returns {Uint8Array}
 */
export function zipWrite(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('zipWrite 的 entries 必须是数组');
  }
  if (entries.length > 0xffff) {
    throw new Error(`ZIP 条目数过多（${entries.length}），最多支持 65535 个`);
  }

  /** @type {Array<{name: string, nameBytes: Buffer, data: Buffer, method: number, crc: number, rawSize: number}>} */
  const plans = [];
  const seen = new Set();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError(`zipWrite 第 ${index + 1} 个条目必须是对象`);
    }
    const name = normalizeEntryNameForWrite(entry.name, index);
    if (seen.has(name)) {
      throw new Error(`ZIP 条目名重复：${name}`);
    }
    seen.add(name);

    const raw = asBuffer(entry.bytes, `ZIP 条目 ${name} 的 bytes`);
    if (raw.length > 0xffffffff) {
      throw new Error(`ZIP 条目过大（${raw.length} 字节），单个文件不能超过 4 GiB：${name}`);
    }

    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    plans.push({
      name,
      nameBytes,
      data,
      method: useDeflate ? 8 : 0,
      crc: crc32(raw),
      rawSize: raw.length,
    });
  }

  // 确定性要求：按条目名排序后再写，输出与调用方传入顺序无关。
  plans.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Buffer[]} */
  const centralChunks = [];
  let offset = 0;

  for (const plan of plans) {
    const local = Buffer.alloc(30);
    writeU32(local, 0, SIG_LOCAL);
    writeU16(local, 4, VERSION_NEEDED);
    writeU16(local, 6, FLAG_UTF8); // bit 11：文件名为 UTF-8
    writeU16(local, 8, plan.method);
    writeU16(local, 10, DOS_TIME_1980);
    writeU16(local, 12, DOS_DATE_1980);
    writeU32(local, 14, plan.crc);
    writeU32(local, 18, plan.data.length);
    writeU32(local, 22, plan.rawSize);
    writeU16(local, 26, plan.nameBytes.length);
    writeU16(local, 28, 0); // extra 长度
    chunks.push(local, plan.nameBytes, plan.data);

    const central = Buffer.alloc(46);
    writeU32(central, 0, SIG_CENTRAL);
    writeU16(central, 4, VERSION_MADE_BY);
    writeU16(central, 6, VERSION_NEEDED);
    writeU16(central, 8, FLAG_UTF8);
    writeU16(central, 10, plan.method);
    writeU16(central, 12, DOS_TIME_1980);
    writeU16(central, 14, DOS_DATE_1980);
    writeU32(central, 16, plan.crc);
    writeU32(central, 20, plan.data.length);
    writeU32(central, 24, plan.rawSize);
    writeU16(central, 28, plan.nameBytes.length);
    writeU16(central, 30, 0); // extra 长度
    writeU16(central, 32, 0); // comment 长度
    writeU16(central, 34, 0); // 起始磁盘号
    writeU16(central, 36, 0); // internal attributes
    writeU32(central, 38, FILE_ATTRS);
    writeU32(central, 42, offset);
    centralChunks.push(central, plan.nameBytes);

    offset += 30 + plan.nameBytes.length + plan.data.length;
    if (offset > 0xffffffff) {
      throw new Error('ZIP 文件过大（超过 4 GiB），暂不支持 ZIP64');
    }
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  writeU32(eocd, 0, SIG_EOCD);
  writeU16(eocd, 4, 0); // 当前磁盘号
  writeU16(eocd, 6, 0); // 中央目录起始磁盘号
  writeU16(eocd, 8, plans.length);
  writeU16(eocd, 10, plans.length);
  writeU32(eocd, 12, centralDirectory.length);
  writeU32(eocd, 16, offset);
  writeU16(eocd, 20, 0); // comment 长度

  return new Uint8Array(Buffer.concat([...chunks, centralDirectory, eocd]));
}

// ─── 读取 ────────────────────────────────────────────────────

/**
 * 从文件末尾向前找 EOCD。ZIP 注释最长 65535 字节，所以最多回看 65557 字节。
 * @param {Buffer} buf
 * @returns {number} EOCD 偏移；找不到返回 -1
 */
function findEocd(buf) {
  const earliest = Math.max(0, buf.length - 22 - 0xffff);
  for (let position = buf.length - 22; position >= earliest; position -= 1) {
    if (readU32(buf, position) !== SIG_EOCD) continue;
    const commentLength = readU16(buf, position + 20);
    if (position + 22 + commentLength === buf.length) return position;
  }
  return -1;
}

/**
 * 解析 ZIP 字节，返回文件条目列表。
 *
 * - 目录条目（以 / 结尾）会被忽略；
 * - 路径遍历 / 绝对路径 / 反斜杠 / 加密 / 不支持的压缩方法都会抛清晰错误；
 * - CRC32 不符、数据截断、ZIP64、分卷也会抛错。
 *
 * @param {Uint8Array|Buffer} bytes
 * @returns {Array<{name: string, bytes: Uint8Array}>}
 */
export function zipRead(bytes) {
  const buf = asBuffer(bytes, 'zipRead 的 bytes');
  if (buf.length < 22) {
    throw new Error('ZIP 数据不完整：长度不足 22 字节，缺少目录结尾（EOCD）');
  }
  const eocdOffset = findEocd(buf);
  if (eocdOffset < 0) {
    throw new Error('不是有效的 ZIP 文件：找不到目录结尾（EOCD），文件可能被截断');
  }

  const diskNumber = readU16(buf, eocdOffset + 4);
  const centralDisk = readU16(buf, eocdOffset + 6);
  const entryCount = readU16(buf, eocdOffset + 10);
  const centralSize = readU32(buf, eocdOffset + 12);
  const centralOffset = readU32(buf, eocdOffset + 16);

  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new Error('暂不支持分卷 ZIP');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的 ZIP');
  }
  if (centralOffset + centralSize > buf.length) {
    throw new Error('ZIP 数据被截断：中央目录超出文件末尾');
  }

  /** @type {Array<{name: string, bytes: Uint8Array}>} */
  const files = [];
  let totalExtracted = 0;
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buf.length) {
      throw new Error(`ZIP 中央目录被截断（第 ${index + 1} 项）`);
    }
    if (readU32(buf, offset) !== SIG_CENTRAL) {
      throw new Error(`ZIP 中央目录损坏：第 ${index + 1} 项签名不对`);
    }

    const flags = readU16(buf, offset + 8);
    const method = readU16(buf, offset + 10);
    const expectedCrc = readU32(buf, offset + 16);
    const compressedSize = readU32(buf, offset + 20);
    const uncompressedSize = readU32(buf, offset + 24);
    const nameLength = readU16(buf, offset + 28);
    const extraLength = readU16(buf, offset + 30);
    const commentLength = readU16(buf, offset + 32);
    const localOffset = readU32(buf, offset + 42);

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buf.length) {
      throw new Error(`ZIP 中央目录被截断：第 ${index + 1} 项的条目名超出文件末尾`);
    }
    const name = buf.toString('utf8', nameStart, nameEnd);
    offset = nameEnd + extraLength + commentLength;

    const safeName = normalizeEntryNameForRead(name);
    if (safeName === null) continue; // 目录条目，忽略

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new Error(`不支持加密的 ZIP 条目：${safeName}`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`不支持的 ZIP 压缩方法 ${method}（条目 ${safeName}），仅支持 store/deflate`);
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error(`ZIP 条目解压后过大（${uncompressedSize} 字节），拒绝解压：${safeName}`);
    }

    // ── 本地文件头 ──
    if (localOffset + 30 > buf.length) {
      throw new Error(`ZIP 数据被截断：条目 ${safeName} 的本地文件头超出文件末尾`);
    }
    if (readU32(buf, localOffset) !== SIG_LOCAL) {
      throw new Error(`ZIP 本地文件头损坏：条目 ${safeName}`);
    }
    const localNameLength = readU16(buf, localOffset + 26);
    const localExtraLength = readU16(buf, localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    if (dataStart > buf.length) {
      throw new Error(`ZIP 数据被截断：条目 ${safeName} 的本地文件头超出文件末尾`);
    }
    const localName = buf.toString('utf8', localNameStart, localNameEnd);
    if (localName !== safeName) {
      throw new Error(`ZIP 条目名不一致（本地头与中央目录）：${safeName} / ${localName}`);
    }

    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`ZIP 数据被截断：条目 ${safeName} 的数据超出文件末尾`);
    }
    const compressed = buf.subarray(dataStart, dataEnd);

    // ── 解压 ──
    let data;
    if (method === 0) {
      data = compressed;
    } else {
      try {
        data = inflateRawSync(compressed, {
          // 多留 1 字节：若实际解压体积大于声明值，这里会直接抛错。
          maxOutputLength: Math.min(uncompressedSize + 1, MAX_ENTRY_BYTES),
        });
      } catch (error) {
        throw new Error(`解压 ZIP 条目失败（${safeName}）：${error.message}`);
      }
    }

    if (data.length !== uncompressedSize) {
      throw new Error(
        `ZIP 条目解压后大小不符（${safeName}）：期望 ${uncompressedSize} 字节，实际 ${data.length} 字节`,
      );
    }
    totalExtracted += data.length;
    if (totalExtracted > MAX_TOTAL_BYTES) {
      throw new Error(`ZIP 解压后总量超过上限（${MAX_TOTAL_BYTES} 字节），拒绝继续解压`);
    }

    const actualCrc = crc32(data);
    if (actualCrc !== expectedCrc) {
      throw new Error(
        `ZIP 条目 CRC32 校验失败（${safeName}）：期望 ${hex8(expectedCrc)}，实际 ${hex8(actualCrc)}`,
      );
    }

    // new Uint8Array(typedArray) 会拷贝内容，避免调用方拿到与输入共享的视图。
    files.push({ name: safeName, bytes: new Uint8Array(data) });
  }

  return files;
}
