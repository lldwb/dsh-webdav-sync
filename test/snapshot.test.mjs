/**
 * 快照协议测试。
 *
 * 覆盖：sha256 向量、snapshotId 公式与稳定性、文件读取、确定性 ZIP artifact、
 * manifest 构建 / 解析 / 兼容性拒绝、verifyArtifact 失败路径、名称与路径规范化，
 * 以及一次「构建 → 远端往返 → 重建仍得到同一 snapshotId」的端到端幂等性验证。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { zipRead } from '../lib/zip.mjs';
import {
  ARTIFACT_CONFIG,
  ARTIFACT_PLUGINS,
  MANIFEST_NAME,
  MAX_DEVICE_NAME_LEN,
  PROTOCOL_FORMAT,
  PROTOCOL_VERSION,
  buildManifest,
  buildZipArtifact,
  computeSnapshotId,
  normalizeDeviceName,
  normalizeRelativeZipPath,
  parseManifest,
  readFileEntries,
  sha256Hex,
  verifyArtifact,
} from '../lib/snapshot.mjs';

// ─── 测试辅助 ────────────────────────────────────────────────

const A_SHA = 'a'.repeat(64);
const B_SHA = 'b'.repeat(64);

/** 构造一组形状合法的 artifacts。 */
function makeArtifacts(configSha = A_SHA, pluginsSha = B_SHA) {
  return {
    [ARTIFACT_CONFIG]: { sha256: configSha, size: 10 },
    [ARTIFACT_PLUGINS]: { sha256: pluginsSha, size: 20 },
  };
}

/** 断言 fn 抛出的错误信息匹配正则。 */
function throwsWith(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

/** 断言 async 调用 reject 且错误信息匹配正则。 */
async function rejectsWith(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

/** 建一个临时目录，并在测试结束后清理。 */
async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-webdav-sync-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ─── 常量与哈希 ─────────────────────────────────────────────

test('协议常量符合设计文档', () => {
  assert.equal(PROTOCOL_FORMAT, 'dsh-webdav-sync');
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(ARTIFACT_CONFIG, 'config.zip');
  assert.equal(ARTIFACT_PLUGINS, 'plugins.zip');
  assert.equal(MANIFEST_NAME, 'manifest.json');
  assert.equal(MAX_DEVICE_NAME_LEN, 64);
});

test('sha256Hex：已知向量、字符串按 UTF-8、非法入参抛 TypeError', () => {
  assert.equal(
    sha256Hex(Buffer.from('hello')),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  assert.equal(
    sha256Hex('hello'),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  assert.equal(
    sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.throws(() => sha256Hex(42), TypeError);
});

test('computeSnapshotId：公式固定、大小写归一并能随 artifact 变化', () => {
  const artifacts = makeArtifacts();
  const expected = sha256Hex(`${ARTIFACT_CONFIG}:${A_SHA}|${ARTIFACT_PLUGINS}:${B_SHA}`);
  assert.equal(computeSnapshotId(artifacts), expected);
  assert.equal(computeSnapshotId(makeArtifacts()), expected, 'snapshotId 必须是确定性的');

  const upper = {
    [ARTIFACT_CONFIG]: { sha256: A_SHA.toUpperCase(), size: 10 },
    [ARTIFACT_PLUGINS]: { sha256: B_SHA.toUpperCase(), size: 20 },
  };
  assert.equal(computeSnapshotId(upper), expected, '大写 sha256 应归一化为小写');

  assert.notEqual(computeSnapshotId(makeArtifacts('c'.repeat(64))), expected);
  assert.notEqual(computeSnapshotId(makeArtifacts(A_SHA, 'd'.repeat(64))), expected);

  throwsWith(
    () => computeSnapshotId({ [ARTIFACT_CONFIG]: artifacts[ARTIFACT_CONFIG] }),
    /缺少 artifact：plugins\.zip/u,
  );
  throwsWith(() => computeSnapshotId({}), /缺少 artifact/u);
  assert.throws(() => computeSnapshotId(null), TypeError);
});

// ─── readFileEntries ───────────────────────────────────────

test('readFileEntries：读取真实文件并计算 sha256 / size / bytes', async (t) => {
  const dir = await makeTempDir(t);
  await writeFile(join(dir, 'a.txt'), 'hello');
  await writeFile(join(dir, 'b.bin'), Buffer.from([1, 2, 3, 4]));

  const entries = await readFileEntries([
    { path: 'conf/a.txt', absPath: join(dir, 'a.txt') },
    { path: 'conf\\b.bin', absPath: join(dir, 'b.bin') },
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, 'conf/a.txt');
  assert.equal(entries[0].size, 5);
  assert.equal(entries[0].sha256, sha256Hex('hello'));
  assert.deepEqual(Buffer.from(entries[0].bytes), Buffer.from('hello'));

  assert.equal(entries[1].path, 'conf/b.bin', '反斜杠应被规范化为正斜杠');
  assert.equal(entries[1].size, 4);
  assert.equal(entries[1].sha256, sha256Hex(Buffer.from([1, 2, 3, 4])));
});

test('readFileEntries：文件不存在时错误信息带 zip 内路径', async (t) => {
  const dir = await makeTempDir(t);
  await rejectsWith(
    readFileEntries([{ path: 'config/missing.yaml', absPath: join(dir, 'nope.yaml') }]),
    /读取文件失败（config\/missing\.yaml）/u,
  );
  await assert.rejects(readFileEntries('not-array'), TypeError);
  await assert.rejects(readFileEntries([{ path: 'a.txt' }]), TypeError);
});

test('readFileEntries：空数组返回空数组', async () => {
  assert.deepEqual(await readFileEntries([]), []);
});

// ─── buildZipArtifact ──────────────────────────────────────

test('buildZipArtifact：确定性 ZIP、sha256/size 自洽、路径排序', () => {
  const files = [
    { path: 'plugins/b.js', bytes: Buffer.from('bbb') },
    { path: 'plugins/a.js', bytes: Buffer.from('aaa') },
    { path: 'plugins/c/中文 文件.txt', bytes: Buffer.from('中文内容', 'utf8') },
  ];
  const artifact = buildZipArtifact(files);
  assert.ok(artifact.bytes instanceof Uint8Array);
  assert.equal(artifact.size, artifact.bytes.length);
  assert.equal(artifact.sha256, sha256Hex(artifact.bytes));

  const entries = zipRead(artifact.bytes);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['plugins/a.js', 'plugins/b.js', 'plugins/c/中文 文件.txt'],
    'zip 内条目应按路径字典序',
  );

  // 同一组文件换一个输入顺序，输出必须逐字节相同（快照幂等的前提）。
  const reversed = buildZipArtifact([...files].reverse());
  assert.deepEqual(Buffer.from(reversed.bytes), Buffer.from(artifact.bytes));
  assert.equal(reversed.sha256, artifact.sha256);
  assert.equal(reversed.size, artifact.size);
});

test('buildZipArtifact：拒绝重复路径与非法 bytes', () => {
  throwsWith(
    () =>
      buildZipArtifact([
        { path: 'a.txt', bytes: Buffer.from('1') },
        { path: 'a.txt', bytes: Buffer.from('2') },
      ]),
    /重复/u,
  );
  assert.throws(() => buildZipArtifact([{ path: 'a.txt', bytes: 'no' }]), TypeError);
  assert.throws(() => buildZipArtifact('no'), TypeError);
  throwsWith(() => buildZipArtifact([{ path: '../x', bytes: Buffer.alloc(1) }]), /\.\./u);
});

// ─── manifest 构建 ─────────────────────────────────────────

test('buildManifest：字段完整、snapshotId 正确、bytes 与 sha256 自洽', () => {
  const artifacts = makeArtifacts();
  const built = buildManifest({
    artifacts,
    deviceName: '  Mac\tBook  ',
    dshVersion: '1.2.3',
    profileName: 'desktop',
    fileCount: 3,
  });

  assert.equal(built.manifest.format, PROTOCOL_FORMAT);
  assert.equal(built.manifest.protocolVersion, PROTOCOL_VERSION);
  assert.equal(built.manifest.deviceName, 'Mac Book');
  assert.equal(built.manifest.dshVersion, '1.2.3');
  assert.equal(built.manifest.profileName, 'desktop');
  assert.equal(built.manifest.fileCount, 3);
  assert.match(built.manifest.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.deepEqual(built.manifest.artifacts, artifacts);
  assert.equal(built.manifest.snapshotId, computeSnapshotId(artifacts));
  assert.equal(built.sha256, sha256Hex(built.bytes));
  assert.deepEqual(JSON.parse(Buffer.from(built.bytes).toString('utf8')), built.manifest);
});

test('buildManifest：缺 artifact / 非法元数据抛错，设备名与 fileCount 有兜底', () => {
  throwsWith(
    () => buildManifest({ artifacts: { [ARTIFACT_CONFIG]: makeArtifacts()[ARTIFACT_CONFIG] } }),
    /缺少 artifact：plugins\.zip/u,
  );
  throwsWith(
    () => buildManifest({ artifacts: { [ARTIFACT_PLUGINS]: makeArtifacts()[ARTIFACT_PLUGINS] } }),
    /缺少 artifact：config\.zip/u,
  );
  throwsWith(
    () =>
      buildManifest({
        artifacts: {
          [ARTIFACT_CONFIG]: { sha256: 'short', size: 1 },
          [ARTIFACT_PLUGINS]: { sha256: B_SHA, size: 2 },
        },
      }),
    /sha256 不合法/u,
  );

  const built = buildManifest({ artifacts: makeArtifacts() });
  assert.equal(built.manifest.deviceName, 'Unknown Device');
  assert.equal(built.manifest.fileCount, 0);
  assert.equal(built.manifest.dshVersion, '');
  assert.equal(built.manifest.profileName, '');
});

// ─── parseManifest ─────────────────────────────────────────

test('parseManifest：与 buildManifest 往返一致（Uint8Array / Buffer / string 都接受）', () => {
  const built = buildManifest({
    artifacts: makeArtifacts(),
    deviceName: 'DESKTOP-ABC',
    dshVersion: '0.9.0',
    profileName: 'default',
    fileCount: 7,
  });
  const expected = built.manifest;

  assert.deepEqual(parseManifest(built.bytes), expected);
  assert.deepEqual(parseManifest(Buffer.from(built.bytes)), expected);
  assert.deepEqual(parseManifest(JSON.stringify(expected)), expected);
});

test('parseManifest：缺失 snapshotId 时按 artifacts 补算', () => {
  const artifacts = makeArtifacts();
  const manifest = {
    format: PROTOCOL_FORMAT,
    protocolVersion: PROTOCOL_VERSION,
    deviceName: 'X',
    artifacts,
  };
  const parsed = parseManifest(JSON.stringify(manifest));
  assert.equal(parsed.snapshotId, computeSnapshotId(artifacts));
});

test('parseManifest：JSON / 格式 / 协议版本不兼容时拒绝', () => {
  const good = {
    format: PROTOCOL_FORMAT,
    protocolVersion: PROTOCOL_VERSION,
    deviceName: 'X',
    artifacts: makeArtifacts(),
  };
  throwsWith(() => parseManifest('{bad json'), /不是合法 JSON/u);
  throwsWith(() => parseManifest('null'), /必须是 JSON 对象/u);
  throwsWith(() => parseManifest('[]'), /必须是 JSON 对象/u);
  throwsWith(
    () => parseManifest(JSON.stringify({ ...good, format: 'cc-switch-webdav-sync' })),
    /格式不兼容/u,
  );
  throwsWith(
    () => parseManifest(JSON.stringify({ ...good, protocolVersion: 2 })),
    /协议版本不兼容：期望 v1，实际 2/u,
  );
  throwsWith(
    () => parseManifest(JSON.stringify({ ...good, protocolVersion: '1' })),
    /协议版本不兼容/u,
  );
  assert.throws(() => parseManifest(42), TypeError);
});

test('parseManifest：artifacts 形状不合法时拒绝（缺项 / 非法 sha / 非法 size）', () => {
  const good = {
    format: PROTOCOL_FORMAT,
    protocolVersion: PROTOCOL_VERSION,
    artifacts: makeArtifacts(),
  };
  const withArtifact = (name, meta) =>
    JSON.stringify({
      ...good,
      artifacts: { ...good.artifacts, [name]: meta },
    });

  throwsWith(() => parseManifest(JSON.stringify({ ...good, artifacts: null })), /缺少 artifacts/u);
  throwsWith(() => parseManifest(JSON.stringify({ ...good, artifacts: [] })), /缺少 artifacts/u);
  throwsWith(
    () =>
      parseManifest(
        JSON.stringify({
          ...good,
          artifacts: { [ARTIFACT_CONFIG]: good.artifacts[ARTIFACT_CONFIG] },
        }),
      ),
    /缺少 artifact：plugins\.zip/u,
  );
  throwsWith(() => parseManifest(withArtifact(ARTIFACT_CONFIG, { sha256: 'xyz', size: 1 })), /sha256 不合法/u);
  throwsWith(
    () => parseManifest(withArtifact(ARTIFACT_CONFIG, { sha256: A_SHA, size: -1 })),
    /size 必须是非负整数/u,
  );
  throwsWith(
    () => parseManifest(withArtifact(ARTIFACT_CONFIG, { sha256: A_SHA, size: 1.5 })),
    /size 必须是非负整数/u,
  );
  throwsWith(() => parseManifest(withArtifact(ARTIFACT_PLUGINS, 'oops')), /元数据必须是对象/u);
});

// ─── verifyArtifact ────────────────────────────────────────

test('verifyArtifact：一致时通过，size / sha256 不符时抛错', () => {
  const bytes = Buffer.from('artifact bytes');
  const meta = { sha256: sha256Hex(bytes), size: bytes.length };
  assert.doesNotThrow(() => verifyArtifact(bytes, meta));

  throwsWith(
    () => verifyArtifact(bytes, { ...meta, size: meta.size + 1 }),
    /大小不匹配：期望 15 字节，实际 14 字节/u,
  );
  throwsWith(
    () => verifyArtifact(bytes, { ...meta, sha256: '0'.repeat(64) }),
    /SHA256 校验失败/u,
  );
  throwsWith(
    () => verifyArtifact(bytes, { sha256: 'zz', size: bytes.length }),
    /meta\.sha256/u,
  );
  assert.throws(() => verifyArtifact('not-bytes', meta), TypeError);
  assert.throws(() => verifyArtifact(bytes, null), TypeError);
});

// ─── 字符串 / 路径规范化 ───────────────────────────────────

test('normalizeDeviceName：折叠空白、去控制字符、截断 64 个码点、空值兜底', () => {
  assert.equal(normalizeDeviceName('  Mac\tBook  Pro\n'), 'Mac Book Pro');
  assert.equal(normalizeDeviceName('DESKTOP-ABC'), 'DESKTOP-ABC');
  assert.equal(normalizeDeviceName('A\u0000B\u0007C'), 'ABC');
  assert.equal(normalizeDeviceName('   \n\t  '), 'Unknown Device');
  assert.equal(normalizeDeviceName(''), 'Unknown Device');
  assert.equal(normalizeDeviceName(undefined), 'Unknown Device');
  assert.equal(normalizeDeviceName(null), 'Unknown Device');
  assert.equal(normalizeDeviceName(123), 'Unknown Device');
  assert.equal(normalizeDeviceName('a'.repeat(80)), 'a'.repeat(64));

  const emoji = normalizeDeviceName('📦'.repeat(80));
  assert.equal(Array.from(emoji).length, 64, '应按 Unicode 码点截断');
  assert.ok(!emoji.includes('\uFFFD'), '不应切坏代理对');
});

test('normalizeRelativeZipPath：正斜杠、去前导 /、折叠空段，拒绝 .. 与盘符', () => {
  assert.equal(normalizeRelativeZipPath('plugins\\foo\\index.js'), 'plugins/foo/index.js');
  assert.equal(normalizeRelativeZipPath('/plugins/foo.js'), 'plugins/foo.js');
  assert.equal(normalizeRelativeZipPath('./plugins//foo.js'), 'plugins/foo.js');
  assert.equal(normalizeRelativeZipPath('  plugins/a b.txt  '), 'plugins/a b.txt');

  throwsWith(() => normalizeRelativeZipPath('../evil.txt'), /\.\./u);
  throwsWith(() => normalizeRelativeZipPath('a/../../evil.txt'), /\.\./u);
  throwsWith(() => normalizeRelativeZipPath(''), /不能为空/u);
  throwsWith(() => normalizeRelativeZipPath('   '), /不能为空/u);
  throwsWith(() => normalizeRelativeZipPath('C:/windows/x.txt'), /盘符绝对路径/u);
  throwsWith(() => normalizeRelativeZipPath(null), /不能为空/u);
});

// ─── 端到端幂等性 ─────────────────────────────────────────

test('端到端：构建快照 → 远端往返校验 → 重建得到相同 snapshotId', async (t) => {
  const dir = await makeTempDir(t);
  await writeFile(join(dir, 'package.json'), '{"name":"demo"}');
  await writeFile(join(dir, 'cordis.patch.yml'), 'plugins: {}\n');
  await writeFile(join(dir, 'plugin.js'), 'export const x = 1;\n');

  const configEntries = await readFileEntries([
    { path: 'package.json', absPath: join(dir, 'package.json') },
    { path: 'cordis.patch.yml', absPath: join(dir, 'cordis.patch.yml') },
  ]);
  const pluginEntries = await readFileEntries([
    { path: 'demo-plugin/index.js', absPath: join(dir, 'plugin.js') },
  ]);

  const config = buildZipArtifact(configEntries);
  const plugins = buildZipArtifact(pluginEntries);
  const artifacts = {
    [ARTIFACT_CONFIG]: { sha256: config.sha256, size: config.size },
    [ARTIFACT_PLUGINS]: { sha256: plugins.sha256, size: plugins.size },
  };
  const built = buildManifest({
    artifacts,
    deviceName: 'DESKTOP-TEST',
    dshVersion: '1.0.0',
    profileName: 'default',
    fileCount: 3,
  });

  // 模拟「上传后从远端下载回来」：解析 manifest 并逐个校验 artifact。
  const remoteManifest = parseManifest(built.bytes);
  verifyArtifact(config.bytes, remoteManifest.artifacts[ARTIFACT_CONFIG]);
  verifyArtifact(plugins.bytes, remoteManifest.artifacts[ARTIFACT_PLUGINS]);
  assert.equal(remoteManifest.snapshotId, built.manifest.snapshotId);

  // 模拟「下载落盘后本地重建快照」：同样的文件重新打包必须得到同样的 snapshotId，
  // 否则自动同步会误判「本地又变了」而反复上传。
  const rebuiltConfig = buildZipArtifact(await readFileEntries([
    { path: 'cordis.patch.yml', absPath: join(dir, 'cordis.patch.yml') },
    { path: 'package.json', absPath: join(dir, 'package.json') },
  ]));
  const rebuiltPlugins = buildZipArtifact(await readFileEntries([
    { path: 'demo-plugin/index.js', absPath: join(dir, 'plugin.js') },
  ]));
  assert.equal(rebuiltConfig.sha256, config.sha256);
  assert.equal(rebuiltPlugins.sha256, plugins.sha256);

  const rebuilt = buildManifest({
    artifacts: {
      [ARTIFACT_CONFIG]: { sha256: rebuiltConfig.sha256, size: rebuiltConfig.size },
      [ARTIFACT_PLUGINS]: { sha256: rebuiltPlugins.sha256, size: rebuiltPlugins.size },
    },
    deviceName: 'DESKTOP-TEST',
    dshVersion: '1.0.0',
    profileName: 'default',
    fileCount: 3,
  });
  assert.equal(rebuilt.manifest.snapshotId, built.manifest.snapshotId);
});
