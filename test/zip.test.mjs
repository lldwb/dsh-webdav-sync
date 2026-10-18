/**
 * ZIP 读写测试。
 *
 * 重点不只是 happy path：
 * - 用最小的中央目录解析器验证「store/deflate 自动选小」确实生效、bit 11 已设置、
 *   DOS 时间固定为 1980-01-01；
 * - 用测试专用的 makeZip 构造器伪造恶意 zip（路径遍历、绝对路径、反斜杠、CRC 错误、
 *   加密、不支持的压缩方法），证明读取侧防护不是摆设；
 * - 用「不同输入顺序 / 不同 mtime / 两次调用」逐字节比对，锁死确定性（快照幂等的前提）。
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { zipRead, zipWrite } from '../lib/zip.mjs';

// ─── 测试辅助 ────────────────────────────────────────────────

/** 独立的 CRC32 实现，避免用被测代码验证被测代码。 */
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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 测试专用 ZIP 构造器：允许任意条目名与人为破坏的字段，
 * 用来覆盖 zipRead 里那些正常写入路径永远走不到的防护分支。
 *
 * @param {Array<{name: string, bytes?: Uint8Array|string, method?: number,
 *   flags?: number, crc?: number, payload?: Uint8Array, uncompressedSize?: number}>} entries
 * @returns {Uint8Array}
 */
function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.from(entry.bytes ?? []);
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const payload =
      entry.payload !== undefined
        ? Buffer.from(entry.payload)
        : method === 8
          ? deflateRawSync(raw)
          : raw;
    const crc = entry.crc !== undefined ? entry.crc : crc32(raw);
    const uncompressedSize = entry.uncompressedSize ?? raw.length;
    const flags = entry.flags ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // DOS time
    local.writeUInt16LE(0, 12); // DOS date
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = offset;
    localParts.push(local, nameBytes, payload);
    offset += 30 + nameBytes.length + payload.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...localParts, centralDirectory, eocd]));
}

/** 解析中央目录，拿到 method / flags / DOS 时间 / 条目名，用于验证写入侧细节。 */
function parseCentralDirectory(zipBytes) {
  const buf = Buffer.from(zipBytes);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1, '测试 zip 里找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const time = buf.readUInt16LE(offset + 12);
    const date = buf.readUInt16LE(offset + 14);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, flags, time, date });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 断言 fn 抛出的错误信息匹配正则（失败时把真实信息带出来）。 */
function throwsWith(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

/** 把 zipRead 的结果转成 Map，便于按名字断言内容。 */
function readToMap(zipBytes) {
  const map = new Map();
  for (const entry of zipRead(zipBytes)) map.set(entry.name, Buffer.from(entry.bytes));
  return map;
}

// ─── 写入 / 读取往返 ────────────────────────────────────────

test('zipWrite / zipRead：多文件往返，store 与 deflate 自动选更小者', () => {
  const files = [
    { name: 'readme.txt', bytes: Buffer.from('hello world') },
    { name: 'bin/random.bin', bytes: randomBytes(2048) },
    { name: 'data/repeat.txt', bytes: Buffer.from('压缩我 '.repeat(500)) },
    { name: 'empty.txt', bytes: new Uint8Array(0) },
  ];
  const zip = zipWrite(files);
  assert.ok(zip instanceof Uint8Array);
  assert.ok(zip.length > 22);

  const read = readToMap(zip);
  assert.deepEqual(
    [...read.keys()].sort(),
    files.map((file) => file.name).sort(),
  );
  for (const file of files) {
    assert.deepEqual(read.get(file.name), Buffer.from(file.bytes), `${file.name} 内容不一致`);
  }

  const central = new Map(parseCentralDirectory(zip).map((entry) => [entry.name, entry]));
  // 高度重复的文本：deflate 明显更小 → method 8
  assert.equal(central.get('data/repeat.txt').method, 8);
  // 随机字节：deflate 反而更大 → store
  assert.equal(central.get('bin/random.bin').method, 0);
  // 空文件：store 是 0 字节，deflate 也要 2 字节 → store
  assert.equal(central.get('empty.txt').method, 0);
});

test('zipWrite：UTF-8 文件名设置 bit 11，中文 / 空格名可往返', () => {
  const name = '配置/同步 说明-📦.txt';
  const zip = zipWrite([{ name, bytes: Buffer.from('中文内容', 'utf8') }]);
  const [central] = parseCentralDirectory(zip);
  assert.equal(central.name, name);
  assert.equal(central.flags & 0x0800, 0x0800, 'general purpose bit 11（UTF-8）未设置');

  const [entry] = zipRead(zip);
  assert.equal(entry.name, name);
  assert.equal(Buffer.from(entry.bytes).toString('utf8'), '中文内容');
});

test('zipWrite：mtime 字段被接受但不影响输出（确定性要求）', () => {
  const base = [{ name: 'a.txt', bytes: Buffer.from('aaa') }];
  const withDate = zipWrite([{ ...base[0], mtime: new Date('2026-10-18T12:00:00Z') }]);
  const withMs = zipWrite([{ ...base[0], mtime: 1_760_000_000_000 }]);
  const withNothing = zipWrite(base);
  assert.deepEqual(Buffer.from(withDate), Buffer.from(withNothing));
  assert.deepEqual(Buffer.from(withMs), Buffer.from(withNothing));
});

test('zipWrite：字节级确定性——输入顺序无关、两次调用相同、DOS 时间固定', () => {
  const entries = [
    { name: 'z-last.txt', bytes: Buffer.from('zzz') },
    { name: 'a/first.txt', bytes: Buffer.from('aaa') },
    { name: 'm/middle.bin', bytes: randomBytes(64) },
  ];
  const forward = Buffer.from(zipWrite(entries));
  const reverse = Buffer.from(zipWrite([...entries].reverse()));
  const again = Buffer.from(zipWrite(entries));

  assert.deepEqual(forward, reverse, '不同输入顺序必须得到逐字节相同的 zip');
  assert.deepEqual(forward, again, '同一输入两次调用必须逐字节相同');

  const central = parseCentralDirectory(forward);
  assert.deepEqual(
    central.map((entry) => entry.name),
    ['a/first.txt', 'm/middle.bin', 'z-last.txt'],
    '条目应按名字字典序写入',
  );
  for (const entry of central) {
    assert.equal(entry.time, 0x0000, `${entry.name} 的 DOS time 不是固定值 0`);
    assert.equal(entry.date, 0x0021, `${entry.name} 的 DOS date 不是固定值 1980-01-01`);
  }
});

test('zipWrite：空数组得到合法的空 ZIP，zipRead 读回空列表', () => {
  const zip = zipWrite([]);
  assert.equal(zip.length, 22);
  assert.deepEqual(zipRead(zip), []);
});

// ─── 写入侧拒绝 ──────────────────────────────────────────────

test('zipWrite：拒绝路径遍历 / 绝对路径 / 反斜杠 / 空名 / 目录名', () => {
  const bytes = new Uint8Array(1);
  const badNames = [
    '../evil.txt',
    'a/../../evil.txt',
    '/absolute.txt',
    'C:/windows/system32.txt',
    'C:\\windows\\system32.txt',
    'a\\b.txt',
    '',
    '   ',
    'a//b.txt',
    './a.txt',
    'dir-only/',
  ];
  for (const name of badNames) {
    assert.throws(
      () => zipWrite([{ name, bytes }]),
      Error,
      `条目名 ${JSON.stringify(name)} 应被拒绝`,
    );
  }
});

test('zipWrite：非法入参抛 TypeError，重复条目名被拒绝', () => {
  assert.throws(() => zipWrite('not-an-array'), TypeError);
  assert.throws(() => zipWrite([null]), TypeError);
  assert.throws(() => zipWrite([{ name: 42, bytes: new Uint8Array(1) }]), TypeError);
  assert.throws(() => zipWrite([{ name: 'a.txt', bytes: 'not-bytes' }]), TypeError);
  throwsWith(
    () =>
      zipWrite([
        { name: 'dup.txt', bytes: new Uint8Array(1) },
        { name: 'dup.txt', bytes: new Uint8Array(2) },
      ]),
    /重复/u,
  );
});

// ─── 读取侧防护 ──────────────────────────────────────────────

test('zipRead：拒绝路径遍历条目（即使它绕过了写入侧校验）', () => {
  throwsWith(
    () => zipRead(makeZip([{ name: '../evil.txt', bytes: Buffer.from('x') }])),
    /\.\./u,
  );
  throwsWith(
    () => zipRead(makeZip([{ name: 'a/../../evil.txt', bytes: Buffer.from('x') }])),
    /\.\./u,
  );
  // 恶意目录条目也不能豁免校验
  throwsWith(() => zipRead(makeZip([{ name: '../evil/', bytes: Buffer.alloc(0) }])), /\.\./u);
});

test('zipRead：拒绝绝对路径与反斜杠条目', () => {
  throwsWith(
    () => zipRead(makeZip([{ name: '/etc/passwd', bytes: Buffer.from('x') }])),
    /绝对路径/u,
  );
  throwsWith(
    () => zipRead(makeZip([{ name: 'C:/windows/win.ini', bytes: Buffer.from('x') }])),
    /盘符绝对路径/u,
  );
  throwsWith(
    () => zipRead(makeZip([{ name: 'a\\b.txt', bytes: Buffer.from('x') }])),
    /反斜杠/u,
  );
});

test('zipRead：CRC32 不符抛清晰错误', () => {
  throwsWith(
    () =>
      zipRead(
        makeZip([{ name: 'a.txt', bytes: Buffer.from('hello'), crc: 0xdeadbeef }]),
      ),
    /CRC32 校验失败/u,
  );
});

test('zipRead：截断 / 非 ZIP / 过短输入都抛清晰错误', () => {
  const valid = zipWrite([{ name: 'a.txt', bytes: Buffer.from('hello world') }]);
  throwsWith(() => zipRead(valid.slice(0, valid.length - 5)), /EOCD|截断/u);
  throwsWith(
    () => zipRead(Buffer.from('this is definitely not a zip file, just plain text!')),
    /EOCD/u,
  );
  throwsWith(() => zipRead(Buffer.alloc(10)), /不完整/u);
  assert.throws(() => zipRead('not-bytes'), TypeError);
});

test('zipRead：目录条目被忽略，只返回文件条目', () => {
  const zip = makeZip([
    { name: 'dir/', bytes: Buffer.alloc(0) },
    { name: 'dir/sub/', bytes: Buffer.alloc(0) },
    { name: 'dir/sub/file.txt', bytes: Buffer.from('ok') },
  ]);
  const entries = zipRead(zip);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['dir/sub/file.txt'],
  );
  assert.equal(Buffer.from(entries[0].bytes).toString('utf8'), 'ok');
});

test('zipRead：加密条目与不支持的压缩方法被拒绝', () => {
  throwsWith(
    () => zipRead(makeZip([{ name: 'secret.txt', bytes: Buffer.from('x'), flags: 0x0001 }])),
    /加密/u,
  );
  throwsWith(
    () => zipRead(makeZip([{ name: 'a.txt', bytes: Buffer.from('x'), method: 12 }])),
    /不支持的 ZIP 压缩方法/u,
  );
});

test('zipRead：能读取外部生成的 deflate 条目', () => {
  const source = Buffer.from('外部 deflate 内容 '.repeat(200));
  const zip = makeZip([{ name: 'external.txt', bytes: source, method: 8 }]);
  const [entry] = zipRead(zip);
  assert.equal(entry.name, 'external.txt');
  assert.deepEqual(Buffer.from(entry.bytes), source);
});
