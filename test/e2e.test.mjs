/**
 * dsh-webdav-sync —— 端到端集成测试。
 *
 * 不连接真实 WebDAV：起一个本地 `node:http` 的 WebDAV mock（PROPFIND/MKCOL/
 * PUT/GET/HEAD），配一份临时 DSH_HOME 与 profile，然后走真实代码路径：
 * uploadSnapshot → 检查远端；改本地文件 → downloadSnapshot → 检查恢复与备份。
 *
 * 覆盖的是「Host 编排 + 三个 lib 模块 + 落盘应用」的连接处，单元测试覆盖不到
 * 的层序（比如 manifest 先传后传、zip 解包后写哪里）在这一层验证。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { applySnapshot } from '../lib/apply.mjs';
import { normalizeRelativeZipPath } from '../lib/snapshot.mjs';

import {
  buildLocalSnapshot,
  buildStatus,
  createRpcHandler,
  patchState,
  readState,
  remoteDirSegments,
  remoteRootSegments,
  resolveOptions,
  resolveProfileInfo,
  sanitizeRemoteSegment,
  shouldTriggerForPath,
  uploadSnapshot,
  downloadSnapshot,
} from '../index.js';

// ─── WebDAV mock ────────────────────────────────────────────

/**
 * 最小可用的 WebDAV mock：只需要支持本插件真正用到的五种方法。
 * 资源以 `Map<pathname, { bytes, etag }>` 保存。
 */
function createMockWebDav() {
  const files = new Map();
  // 真实 WebDAV 的 base 路径（本 mock 的 `/dav`）必然已存在，预置到目录表里。
  const dirs = new Set(['/', '/dav']);
  /** 注入故障的 GET 路径（用于测试 fail-closed 行为）。 */
  const failGets = new Set();
  let etagCounter = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'content-type': 'application/xml' });
      res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
      return;
    }
    if (req.method === 'MKCOL') {
      const target = pathname.replace(/\/+$/u, '');
      // 父目录必须存在，否则像真实实现一样返回 409。
      const parent = target.slice(0, target.lastIndexOf('/')) || '/';
      if (!dirs.has(parent) && parent !== '') {
        res.writeHead(409);
        res.end('parent missing');
        return;
      }
      dirs.add(target);
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      etagCounter += 1;
      files.set(pathname, { bytes: body, etag: `"etag-${etagCounter}"` });
      res.writeHead(201, { etag: `"etag-${etagCounter}"` });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      if (failGets.has(pathname)) {
        res.writeHead(500);
        res.end('injected failure');
        return;
      }
      const file = files.get(pathname);
      if (file === undefined) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', etag: file.etag });
      res.end(file.bytes);
      return;
    }
    if (req.method === 'HEAD') {
      const file = files.get(pathname);
      if (file === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { etag: file.etag });
      res.end();
      return;
    }
    res.writeHead(405);
    res.end('unsupported');
  });
  return { server, files, dirs, failGets };
}

// ─── 夹具 ───────────────────────────────────────────────────

const fixtures = {};

before(async () => {
  fixtures.root = await mkdtemp(path.join(tmpdir(), 'dsh-webdav-sync-test-'));
  fixtures.dshHome = path.join(fixtures.root, 'home');
  fixtures.profileDir = path.join(fixtures.dshHome, 'profiles', 'test-profile');
  fixtures.pluginDir = path.join(fixtures.root, 'plugins', 'demo-plugin');
  await mkdir(fixtures.profileDir, { recursive: true });
  await mkdir(fixtures.pluginDir, { recursive: true });

  await writeFile(
    path.join(fixtures.profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-test',
        dependencies: { 'demo-plugin': 'link:../../../plugins/demo-plugin' },
        dsh: { profile: { bundles: ['demo-plugin'] } },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(fixtures.profileDir, 'cordis.patch.yml'), '- id: demo\n  name: demo-plugin\n');
  await writeFile(path.join(fixtures.profileDir, 'cordis.yml'), '[]\n');
  await writeFile(path.join(fixtures.profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(fixtures.dshHome, '.credentials.yaml'), 'version: 1\nkeys:\n  DEMO_KEY: demo-value\n');
  await writeFile(path.join(fixtures.pluginDir, 'package.json'), '{"name":"demo-plugin","version":"0.0.1"}\n');
  await writeFile(path.join(fixtures.pluginDir, 'index.js'), 'export const name = "demo-plugin";\n');
  await mkdir(path.join(fixtures.pluginDir, 'node_modules', 'ignored'), { recursive: true });
  await writeFile(path.join(fixtures.pluginDir, 'node_modules', 'ignored', 'x.js'), 'ignored\n');
  await writeFile(path.join(fixtures.pluginDir, 'debug.log'), 'should not sync\n');

  const mock = createMockWebDav();
  fixtures.webdav = mock.server;
  fixtures.files = mock.files;
  fixtures.dirs = mock.dirs;
  fixtures.failGets = mock.failGets;
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const address = mock.server.address();
  fixtures.baseUrl = `http://127.0.0.1:${address.port}/dav/`;

  fixtures.previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = fixtures.dshHome;

  fixtures.ctx = {
    get(name) {
      if (name === 'profileContext') return { dir: fixtures.profileDir, name: 'test-profile' };
      if (name === 'credentials') {
        return {
          resolve: async (ref) =>
            ref === 'DSH_WEBDAV_SYNC_PASSWORD' ? { value: 'test-password' } : undefined,
        };
      }
      return undefined;
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };

  fixtures.config = {
    provider: 'webdav',
    providerPreset: 'custom',
    baseUrl: fixtures.baseUrl,
    username: 'tester',
    passwordRef: 'DSH_WEBDAV_SYNC_PASSWORD',
    remoteRoot: 'dsh-sync',
    syncProfile: 'default',
    autoSync: false,
    syncCredentials: true,
    timeoutMs: 5000,
    maxArtifactBytes: 64 * 1024 * 1024,
    maxPluginBytes: 20 * 1024 * 1024,
    backupKeep: 3,
  };
  fixtures.options = resolveOptions(fixtures.ctx, fixtures.config);
});

after(async () => {
  if (fixtures.webdav !== undefined) {
    await new Promise((resolve) => fixtures.webdav.close(resolve));
  }
  if (fixtures.previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = fixtures.previousHome;
  await rm(fixtures.root, { recursive: true, force: true });
});

// ─── 用例 ───────────────────────────────────────────────────

test('平台相关纯函数：远端目录清洗与监听过滤', () => {
  assert.deepEqual(remoteRootSegments(''), ['dsh-sync']);
  assert.deepEqual(remoteRootSegments('a/b'), ['a', 'b']);
  assert.deepEqual(remoteRootSegments('../evil'), ['evil']);
  assert.equal(sanitizeRemoteSegment('bad:name?', 'default'), 'bad-name-');
  assert.equal(sanitizeRemoteSegment('   ', 'default'), 'default');
  assert.equal(sanitizeRemoteSegment('..', 'default'), 'default');

  const segments = remoteDirSegments({ remoteRoot: 'dsh-sync', syncProfile: 'home' });
  assert.deepEqual(segments, ['dsh-sync', 'v1', 'home']);

  assert.equal(shouldTriggerForPath('cordis.patch.yml', 'profile'), true);
  assert.equal(shouldTriggerForPath('node_modules\\x\\y.js', 'profile'), false);
  assert.equal(shouldTriggerForPath('.plugin-manager/logs/a.log', 'profile'), false);
  assert.equal(shouldTriggerForPath('plugins/demo/index.js', 'profile'), true);
  assert.equal(shouldTriggerForPath('.credentials.yaml', 'home'), true);
  assert.equal(shouldTriggerForPath('cache/x', 'home'), false);
  assert.equal(shouldTriggerForPath(undefined, 'profile'), false);

  const profile = resolveProfileInfo(fixtures.ctx);
  assert.equal(profile.name, 'test-profile');
  assert.equal(profile.dir, fixtures.profileDir);
});

test('buildLocalSnapshot：配置文件 + 插件包内容（排除 node_modules/日志）', async () => {
  const snapshot = await buildLocalSnapshot({
    profileDir: fixtures.profileDir,
    dshHome: fixtures.dshHome,
    profileName: 'test-profile',
    deviceName: 'Test Device',
    dshVersion: '0.0.0',
    syncCredentials: true,
    maxPluginBytes: 20 * 1024 * 1024,
  });
  const paths = snapshot.configFiles.map((file) => file.path).sort();
  assert.deepEqual(paths, [
    'home/.credentials.yaml',
    'profile/cordis.patch.yml',
    'profile/cordis.yml',
    'profile/package.json',
    'profile/pnpm-lock.yaml',
  ]);
  const pluginPaths = snapshot.pluginFiles.map((file) => file.path);
  assert.ok(pluginPaths.includes('demo-plugin/index.js'));
  assert.ok(pluginPaths.includes('demo-plugin/package.json'));
  assert.ok(pluginPaths.includes('_plugins.json'));
  assert.ok(!pluginPaths.some((name) => name.includes('node_modules')), 'node_modules 不应被同步');
  assert.ok(!pluginPaths.some((name) => name.endsWith('.log')), '*.log 不应被同步');
  assert.equal(snapshot.manifest.format, 'dsh-webdav-sync');
  assert.equal(snapshot.manifest.fileCount, snapshot.configFiles.length + snapshot.pluginFiles.length);
  assert.equal(snapshot.snapshotId.length, 64);

  // 内容不变时 snapshotId 必须稳定（自动同步依赖它去重）。
  const again = await buildLocalSnapshot({
    profileDir: fixtures.profileDir,
    dshHome: fixtures.dshHome,
    profileName: 'test-profile',
    deviceName: 'Test Device',
    dshVersion: '0.0.0',
    syncCredentials: true,
    maxPluginBytes: 20 * 1024 * 1024,
  });
  assert.equal(again.snapshotId, snapshot.snapshotId);
});

test('uploadSnapshot：按 config → plugins → manifest 顺序写入远端并记录状态', async () => {
  const result = await uploadSnapshot(fixtures.ctx, fixtures.options);
  assert.equal(result.action, 'upload');
  assert.match(result.remotePath, /^\/dsh-sync\/v1\/default$/u);
  assert.equal(result.snapshotId.length, 64);

  const dir = '/dav/dsh-sync/v1/default';
  assert.ok(fixtures.dirs.has(dir), '远端目录应已创建');
  const manifestEntry = fixtures.files.get(`${dir}/manifest.json`);
  assert.ok(manifestEntry !== undefined, 'manifest 应已上传');
  const manifest = JSON.parse(manifestEntry.bytes.toString('utf8'));
  assert.equal(manifest.format, 'dsh-webdav-sync');
  assert.equal(manifest.protocolVersion, 1);
  assert.ok(fixtures.files.has(`${dir}/config.zip`));
  assert.ok(fixtures.files.has(`${dir}/plugins.zip`));

  const state = await readState(fixtures.dshHome);
  assert.equal(typeof state.lastSyncAt, 'number');
  assert.equal(state.lastSuccess, 'upload');
  assert.equal(state.lastLocalSnapshotId, result.snapshotId);
});

test('downloadSnapshot：恢复远端内容、写备份、保留本地新增文件以外的一切', async () => {
  // 上传后再改本地：protocol 快照里应恢复回上传时的版本。
  await writeFile(path.join(fixtures.profileDir, 'cordis.patch.yml'), '- id: changed\n');
  const result = await downloadSnapshot(fixtures.ctx, fixtures.options);
  assert.equal(result.action, 'download');
  assert.equal(result.requiresRestart, true);
  assert.ok(result.written >= 5);

  const restored = await readFile(path.join(fixtures.profileDir, 'cordis.patch.yml'), 'utf8');
  assert.equal(restored, '- id: demo\n  name: demo-plugin\n', '应恢复为远端快照内容');

  // 备份目录里应有被覆盖文件的副本（旧内容），且路径与 zip 内相对路径一致
  const backedPatch = await readFile(path.join(result.backupDir, 'profile', 'cordis.patch.yml'), 'utf8');
  assert.equal(backedPatch, '- id: changed\n', '备份里应是被覆盖前的旧内容');
  const backedCredentials = await readFile(path.join(result.backupDir, 'home', '.credentials.yaml'), 'utf8');
  assert.match(backedCredentials, /DEMO_KEY/u);

  // 插件包写回原路径
  const pluginEntry = result.plugins.find((item) => item.name === 'demo-plugin');
  assert.ok(pluginEntry !== undefined);
  assert.equal(pluginEntry.fallback, false);
  const pluginSource = await readFile(path.join(fixtures.pluginDir, 'index.js'), 'utf8');
  assert.match(pluginSource, /demo-plugin/u);

  const state = await readState(fixtures.dshHome);
  assert.equal(state.lastSuccess, 'download');
  assert.equal(state.lastLocalSnapshotId, result.localSnapshotId);
  // 同机恢复（插件写回原目录）不会改写依赖，本地重建快照应与远端一致。
  assert.equal(result.adapted, false);
  assert.equal(result.localSnapshotId, result.snapshotId);
});

test('buildStatus：状态、平台信息与密码存在性', async () => {
  const status = await buildStatus(fixtures.ctx, fixtures.config, { busy: false });
  assert.equal(status.configured, true);
  assert.equal(status.busy, false);
  assert.equal(status.platform.profileName, 'test-profile');
  assert.equal(status.platform.dshHome, fixtures.dshHome);
  assert.equal(status.config.baseUrl, fixtures.baseUrl);
  assert.equal(status.config.passwordConfigured, true);
  assert.equal(status.remotePath, '/dsh-sync/v1/default');
  assert.equal(status.state.lastSuccess, 'download');
});

test('RPC handler：信封形状、BUSY 互斥、错误码与 details 对象', async () => {
  const runtime = { busy: false };
  const handler = createRpcHandler(fixtures.ctx, fixtures.config, runtime);

  const status = await handler('status', {}, undefined);
  assert.equal(status.ok, true);
  assert.equal(typeof status.value, 'object');

  const unknown = await handler('nope', {}, undefined);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UNKNOWN_ENDPOINT');
  assert.deepEqual(unknown.error.details, {});

  // BUSY：抢占 runtime.busy 后所有动作端点都应立即返回 BUSY。
  runtime.busy = true;
  const busy = await handler('test', {}, undefined);
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, 'BUSY');
  runtime.busy = false;

  // 连接测试真的打到 mock WebDAV
  const tested = await handler('test', {}, undefined);
  assert.equal(tested.ok, true);
  assert.match(tested.value.remotePath, /^\/dsh-sync\/v1\/default$/u);

  // 未配置时给 NOT_CONFIGURED
  const bareHandler = createRpcHandler(
    fixtures.ctx,
    { ...fixtures.config, baseUrl: '' },
    { busy: false },
  );
  const notConfigured = await bareHandler('upload', {}, undefined);
  assert.equal(notConfigured.ok, false);
  assert.equal(notConfigured.error.code, 'NOT_CONFIGURED');
  assert.deepEqual(notConfigured.error.details, {});

  // 配置快照读取兼容 volatile 引用
  const fakeConfig = { autoSync: { get: () => false }, syncCredentials: { get: () => false } };
  const options = resolveOptions({}, fakeConfig);
  assert.equal(options.autoSync, false);
  assert.equal(options.syncCredentials, false);
});

test('patchState：状态合并写盘', async () => {
  await patchState(fixtures.dshHome, { lastError: 'boom', lastErrorAt: 123 });
  const state = await readState(fixtures.dshHome);
  assert.equal(state.lastError, 'boom');
  assert.equal(state.lastErrorAt, 123);
  assert.equal(typeof state.lastSyncAt, 'number');
});

// ─── 安全与兼容性用例（独立 fixture，顺序不依赖上面的远端状态） ───

/** 造一份只含 profile/home 目录的临时夹具。 */
async function makeApplyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-webdav-apply-'));
  const profileDir = path.join(root, 'profile');
  const dshHome = path.join(root, 'home');
  await mkdir(profileDir, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  await writeFile(path.join(profileDir, 'package.json'), '{"name":"p","dependencies":{}}\n');
  return { root, profileDir, dshHome, backupsRoot: path.join(dshHome, 'webdav-sync', 'backups') };
}

test('downloadSnapshot：artifact 校验失败时中止且不写本地文件', async () => {
  const key = '/dav/dsh-sync/v1/default/config.zip';
  const entry = fixtures.files.get(key);
  assert.ok(entry !== undefined, '前序上传应已写入 config.zip');
  const tampered = Buffer.from(entry.bytes);
  tampered[tampered.length - 1] ^= 0xff;
  fixtures.files.set(key, { bytes: tampered, etag: '"tampered"' });

  const patchBefore = await readFile(path.join(fixtures.profileDir, 'cordis.patch.yml'), 'utf8');
  await assert.rejects(downloadSnapshot(fixtures.ctx, fixtures.options), /校验|sha256|大小/iu);
  assert.equal(
    await readFile(path.join(fixtures.profileDir, 'cordis.patch.yml'), 'utf8'),
    patchBefore,
    '校验失败时不应写入任何本地文件',
  );
});

test('uploadSnapshot：远端 manifest 协议不兼容时拒绝覆盖', async () => {
  const dir = '/dav/dsh-sync/v1/default';
  fixtures.files.set(`${dir}/manifest.json`, {
    bytes: Buffer.from(JSON.stringify({ format: 'dsh-webdav-sync', protocolVersion: 2, artifacts: {} })),
    etag: '"v2"',
  });
  await assert.rejects(
    uploadSnapshot(fixtures.ctx, fixtures.options),
    (error) => error?.code === 'MANIFEST_INCOMPATIBLE',
  );
});

test('applySnapshot：配置文件白名单（拒绝 sessions/node_modules 等路径）', async () => {
  const fx = await makeApplyFixture();
  try {
    const result = await applySnapshot({
      configEntries: [
        { name: 'profile/package.json', bytes: Buffer.from('{"name":"p"}\n') },
        { name: 'profile/sessions/evil.json', bytes: Buffer.from('{}') },
        { name: 'home/sessions/evil.json', bytes: Buffer.from('{}') },
        { name: 'home/.credentials.yaml', bytes: Buffer.from('version: 1\n') },
      ],
      pluginEntries: [],
      pluginList: [],
      profileDir: fx.profileDir,
      dshHome: fx.dshHome,
      backupsRoot: fx.backupsRoot,
      backupKeep: 2,
    });
    assert.equal(result.warnings.some((warning) => warning.includes('profile/sessions/evil.json')), true);
    assert.equal(result.warnings.some((warning) => warning.includes('home/sessions/evil.json')), true);
    assert.equal(existsSync(path.join(fx.profileDir, 'sessions', 'evil.json')), false);
    assert.equal(existsSync(path.join(fx.dshHome, 'sessions', 'evil.json')), false);
    assert.equal(await readFile(path.join(fx.dshHome, '.credentials.yaml'), 'utf8'), 'version: 1\n');
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('applySnapshot：远端 _plugins.json 的 originalDir 不被直接采用', async () => {
  const fx = await makeApplyFixture();
  const outside = path.join(fx.root, 'outside');
  await mkdir(outside, { recursive: true });
  try {
    const result = await applySnapshot({
      configEntries: [],
      pluginEntries: [
        { name: 'demo/index.js', bytes: Buffer.from('evil\n') },
        { name: '_plugins.json', bytes: Buffer.from(JSON.stringify([{ name: 'demo', originalDir: outside }])) },
      ],
      pluginList: [{ name: 'demo', originalDir: outside }],
      profileDir: fx.profileDir,
      dshHome: fx.dshHome,
      backupsRoot: fx.backupsRoot,
      backupKeep: 2,
    });
    assert.equal(result.plugins[0].fallback, true, '本地未声明该依赖时必须回退到 profile 内');
    assert.equal(await readFile(path.join(fx.profileDir, 'plugins', 'demo', 'index.js'), 'utf8'), 'evil\n');
    assert.equal(existsSync(path.join(outside, 'index.js')), false, '不能写到远端指定的任意路径');
    const manifest = JSON.parse(await readFile(path.join(fx.profileDir, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies.demo, 'link:./plugins/demo');
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('applySnapshot：插件目标禁止系统目录（回退到 profile 内）', async (t) => {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) {
    t.skip('非 Windows 环境，跳过系统目录用例');
    return;
  }
  const fx = await makeApplyFixture();
  try {
    await writeFile(
      path.join(fx.profileDir, 'package.json'),
      JSON.stringify({ name: 'p', dependencies: { demo: `link:${systemRoot}` } }),
    );
    const result = await applySnapshot({
      configEntries: [],
      pluginEntries: [
        { name: 'demo/index.js', bytes: Buffer.from('evil\n') },
        { name: '_plugins.json', bytes: Buffer.from(JSON.stringify([{ name: 'demo', originalDir: systemRoot }])) },
      ],
      pluginList: [{ name: 'demo', originalDir: systemRoot }],
      profileDir: fx.profileDir,
      dshHome: fx.dshHome,
      backupsRoot: fx.backupsRoot,
      backupKeep: 2,
    });
    assert.equal(result.plugins[0].fallback, true);
    assert.equal(existsSync(path.join(systemRoot, 'demo')), false);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('uploadSnapshot：读取远端 manifest 失败时中止（fail-closed，不覆盖）', async () => {
  const dir = '/dav/dsh-sync/v1/default';
  fixtures.failGets.add(`${dir}/manifest.json`);
  try {
    await assert.rejects(
      uploadSnapshot(fixtures.ctx, fixtures.options),
      (error) => error?.code === 'REMOTE_UNREADABLE',
    );
  } finally {
    fixtures.failGets.delete(`${dir}/manifest.json`);
  }
});

test('applySnapshot：配置白名单拒绝后也不会用远端 package.json 决定插件目标', async () => {
  // 即使远端 config.zip 把 package.json 改成 link:任意已存在目录，插件目标
  // 也只能来自 trustedDependencies（下载前本地声明）；这里传空 Map，必须回退。
  const fx = await makeApplyFixture();
  const outside = path.join(fx.root, 'outside');
  await mkdir(outside, { recursive: true });
  try {
    const result = await applySnapshot({
      configEntries: [
        {
          name: 'profile/package.json',
          bytes: Buffer.from(JSON.stringify({ name: 'p', dependencies: { demo: `link:${outside}` } })),
        },
      ],
      pluginEntries: [
        { name: 'demo/pwn.js', bytes: Buffer.from('pwn\n') },
        { name: '_plugins.json', bytes: Buffer.from(JSON.stringify([{ name: 'demo', originalDir: outside }])) },
      ],
      pluginList: [{ name: 'demo', originalDir: outside }],
      trustedDependencies: new Map(),
      profileDir: fx.profileDir,
      dshHome: fx.dshHome,
      backupsRoot: fx.backupsRoot,
      backupKeep: 2,
    });
    assert.equal(result.plugins[0].fallback, true);
    assert.equal(existsSync(path.join(outside, 'pwn.js')), false, '远端 package.json 不能决定写入位置');
    assert.equal(await readFile(path.join(fx.profileDir, 'plugins', 'demo', 'pwn.js'), 'utf8'), 'pwn\n');
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('applySnapshot：allowCredentials=false 时忽略远端的 .credentials.yaml', async () => {
  const fx = await makeApplyFixture();
  try {
    const result = await applySnapshot({
      configEntries: [
        { name: 'home/.credentials.yaml', bytes: Buffer.from('version: 1\nkeys:\n  REMOTE: leaked\n') },
      ],
      pluginEntries: [],
      pluginList: [],
      allowCredentials: false,
      profileDir: fx.profileDir,
      dshHome: fx.dshHome,
      backupsRoot: fx.backupsRoot,
      backupKeep: 2,
    });
    assert.equal(result.warnings.some((warning) => warning.includes('syncCredentials=false')), true);
    assert.equal(existsSync(path.join(fx.dshHome, '.credentials.yaml')), false);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('normalizeRelativeZipPath：拒绝 Windows 怪物文件名', () => {
  const reject = (value) => assert.throws(() => normalizeRelativeZipPath(value), /ZIP 路径/u);
  reject('a/.. /x');
  reject('a/trail./x');
  reject('a/trail /x');
  reject('CON/x');
  reject('NUL.txt/x');
  reject('a.txt:stream');
  reject('a/\u0001bad');
  assert.equal(normalizeRelativeZipPath('plugins/我的 文件.txt'), 'plugins/我的 文件.txt');
});
