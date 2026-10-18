/**
 * WebDAV 传输层测试。
 *
 * 全部用本地 node:http mock server，不碰外网：
 * - 成功路径验证方法 / URL 编码 / Depth 头 / Basic Auth / body 字节；
 * - 失败路径验证 401、403、404、网络错误、超时、响应体超上限的具体错误码与中文提示；
 * - 额外断言「密码不会被写进错误信息」「非法路径段不会发出请求」。
 *
 * 注：坚果云专属提示分支依赖目标 host 含 jianguoyun.com / nutstore，本地 mock
 * 无法在不访问外网的前提下触发，由 normalizeBaseUrl 的坚果云地址用例覆盖地址解析部分。
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { WebDavError, basicAuthHeader, createWebDav, normalizeBaseUrl } from '../lib/webdav.mjs';

// ─── 测试辅助 ────────────────────────────────────────────────

/**
 * 启动一个记录请求的 mock HTTP server。
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: Buffer, calls: Array<object>) => void} handler
 * @returns {Promise<{baseUrl: string, calls: Array<{method: string, url: string, headers: object, body: Buffer}>, close: () => Promise<void>}>}
 */
async function startServer(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    res.on('error', () => {}); // 客户端提前取消连接时忽略 EPIPE
    const chunks = [];
    req.on('error', () => {});
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      try {
        handler(req, res, body, calls);
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
  });
  server.on('clientError', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** 断言错误是 WebDavError 且 code 匹配。 */
function throwsWithCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof WebDavError, `期望 WebDavError，实际：${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** 断言 async 调用 reject 为 WebDavError 且 code 匹配。 */
async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WebDavError, `期望 WebDavError，实际：${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

const authOf = (username, password) =>
  `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

// ─── 纯函数 ──────────────────────────────────────────────────

test('normalizeBaseUrl：仅接受 http/https、去掉尾部斜杠、保留目录路径', () => {
  assert.equal(
    normalizeBaseUrl('https://dav.jianguoyun.com/dav/'),
    'https://dav.jianguoyun.com/dav',
  );
  assert.equal(
    normalizeBaseUrl('https://dav.jianguoyun.com/dav///'),
    'https://dav.jianguoyun.com/dav',
  );
  assert.equal(normalizeBaseUrl('  http://127.0.0.1:8080  '), 'http://127.0.0.1:8080');
  assert.equal(normalizeBaseUrl('https://example.com/'), 'https://example.com');
  // 中文目录保留可用的 percent-encoded 形式
  assert.equal(
    normalizeBaseUrl('https://dav.jianguoyun.com/dav/我的坚果云'),
    'https://dav.jianguoyun.com/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91',
  );
});

test('normalizeBaseUrl：空 / 非法 / 非 http(s) / 带凭据 / 带 query 全部拒绝', () => {
  throwsWithCode(() => normalizeBaseUrl(''), 'WEBDAV_INVALID_URL');
  throwsWithCode(() => normalizeBaseUrl('   '), 'WEBDAV_INVALID_URL');
  throwsWithCode(() => normalizeBaseUrl('ftp://example.com/dav'), 'WEBDAV_INVALID_URL');
  throwsWithCode(() => normalizeBaseUrl('not a url'), 'WEBDAV_INVALID_URL');
  throwsWithCode(
    () => normalizeBaseUrl('https://alice:secret@example.com/dav'),
    'WEBDAV_INVALID_URL',
  );
  throwsWithCode(() => normalizeBaseUrl('https://example.com/dav?token=1'), 'WEBDAV_INVALID_URL');
  throwsWithCode(() => normalizeBaseUrl('https://example.com/dav#frag'), 'WEBDAV_INVALID_URL');
  assert.throws(() => normalizeBaseUrl(null), WebDavError);
  assert.throws(() => normalizeBaseUrl(undefined), WebDavError);
});

test('basicAuthHeader：用户名为空返回 null，否则用 Buffer 做 base64', () => {
  assert.equal(basicAuthHeader('', 'secret'), null);
  assert.equal(basicAuthHeader('   ', 'secret'), null);
  assert.equal(basicAuthHeader(undefined, undefined), null);
  assert.equal(basicAuthHeader('alice', 'secret'), authOf('alice', 'secret'));
  // 用户名 trim，但密码必须原样保留
  assert.equal(basicAuthHeader('  alice ', ' p '), authOf('alice', ' p '));
  assert.equal(basicAuthHeader('alice', ''), `Basic ${Buffer.from('alice:').toString('base64')}`);
  // 中文用户名按 UTF-8 编码
  assert.equal(basicAuthHeader('张三', '密码'), authOf('张三', '密码'));
});

// ─── 创建客户端 ──────────────────────────────────────────────

test('createWebDav：非法地址在创建阶段就抛 WEBDAV_INVALID_URL', async () => {
  await rejectsWithCode(createWebDav({ baseUrl: '' }), 'WEBDAV_INVALID_URL');
  await rejectsWithCode(createWebDav({ baseUrl: 'ftp://x' }), 'WEBDAV_INVALID_URL');
  await rejectsWithCode(createWebDav({ baseUrl: null }), 'WEBDAV_INVALID_URL');
});

// ─── testConnection ─────────────────────────────────────────

test('testConnection：PROPFIND Depth:0，207 Multi-Status 视为成功', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    res.end('<d:multistatus xmlns:d="DAV:"/>');
  });
  t.after(() => server.close());

  const dav = await createWebDav({
    baseUrl: `${server.baseUrl}/dav`,
    username: 'alice',
    password: 'secret',
  });
  await dav.testConnection();

  assert.equal(server.calls.length, 1);
  const [call] = server.calls;
  assert.equal(call.method, 'PROPFIND');
  assert.equal(call.url, '/dav/');
  assert.equal(call.headers.depth, '0');
  assert.equal(call.headers.authorization, authOf('alice', 'secret'));
});

test('testConnection：baseUrl 没有路径时探测根路径 /，匿名访问不带 Authorization', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200);
    res.end();
  });
  t.after(() => server.close());

  const dav = await createWebDav({ baseUrl: server.baseUrl });
  await dav.testConnection();
  assert.equal(server.calls[0].url, '/');
  assert.equal(server.calls[0].headers.authorization, undefined);
});

test('testConnection：401 抛 WEBDAV_AUTH，且错误信息不包含密码', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(401);
    res.end('unauthorized');
  });
  t.after(() => server.close());

  const dav = await createWebDav({
    baseUrl: server.baseUrl,
    username: 'alice',
    password: 'top-secret-password',
  });
  await assert.rejects(dav.testConnection(), (error) => {
    assert.equal(error.code, 'WEBDAV_AUTH');
    assert.match(error.message, /401/u);
    assert.match(error.message, /用户名|密码/u);
    assert.ok(
      !error.message.includes('top-secret-password'),
      `错误信息泄漏了密码：${error.message}`,
    );
    return true;
  });
});

test('testConnection：500 抛 WEBDAV_HTTP', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  t.after(() => server.close());
  const dav = await createWebDav({ baseUrl: server.baseUrl });
  await rejectsWithCode(dav.testConnection(), 'WEBDAV_HTTP');
});

// ─── ensureDirectories ─────────────────────────────────────

test('ensureDirectories：逐级 MKCOL、URL 末尾补 /、405/409 视为已存在、段做 percent-encode', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === '/dsh-sync/') res.writeHead(201);
    else if (req.url === '/dsh-sync/v1/') res.writeHead(405); // 已存在
    else if (req.url === '/dsh-sync/v1/default%20profile/') res.writeHead(409); // 已存在
    else res.writeHead(500);
    res.end();
  });
  t.after(() => server.close());

  const dav = await createWebDav({ baseUrl: server.baseUrl, username: 'u', password: 'p' });
  await dav.ensureDirectories(['dsh-sync', 'v1', 'default profile']);

  assert.deepEqual(
    server.calls.map((call) => [call.method, call.url]),
    [
      ['MKCOL', '/dsh-sync/'],
      ['MKCOL', '/dsh-sync/v1/'],
      ['MKCOL', '/dsh-sync/v1/default%20profile/'],
    ],
  );
});

test('ensureDirectories：中文目录名按 UTF-8 percent-encode，空数组不发请求', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(201);
    res.end();
  });
  t.after(() => server.close());

  const dav = await createWebDav({ baseUrl: server.baseUrl });
  await dav.ensureDirectories([]);
  assert.equal(server.calls.length, 0);

  await dav.ensureDirectories(['我的同步']);
  assert.deepEqual(
    server.calls.map((call) => call.url),
    ['/%E6%88%91%E7%9A%84%E5%90%8C%E6%AD%A5/'],
  );
});

test('ensureDirectories：401 抛 WEBDAV_AUTH（带权限提示）', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(401);
    res.end();
  });
  t.after(() => server.close());
  const dav = await createWebDav({ baseUrl: server.baseUrl, username: 'u', password: 'wrong' });
  await assert.rejects(dav.ensureDirectories(['dsh-sync']), (error) => {
    assert.equal(error.code, 'WEBDAV_AUTH');
    assert.match(error.message, /用户名|密码|权限/u);
    return true;
  });
});

// ─── put ───────────────────────────────────────────────────

test('put：上传字节、带 Content-Type / Basic Auth、路径段逐段编码', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(201);
    res.end();
  });
  t.after(() => server.close());

  const dav = await createWebDav({
    baseUrl: server.baseUrl,
    username: 'alice',
    password: 'secret',
  });
  const bytes = Buffer.from('PK\u0003\u0004 fake zip bytes');
  await dav.put(['dsh-sync', 'v1', 'default', 'config.zip'], bytes, 'application/zip');

  assert.equal(server.calls.length, 1);
  const [call] = server.calls;
  assert.equal(call.method, 'PUT');
  assert.equal(call.url, '/dsh-sync/v1/default/config.zip');
  assert.equal(call.headers['content-type'], 'application/zip');
  assert.equal(call.headers.authorization, authOf('alice', 'secret'));
  assert.deepEqual(call.body, bytes);
});

test('put：默认 Content-Type 是 application/octet-stream', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(204);
    res.end();
  });
  t.after(() => server.close());
  const dav = await createWebDav({ baseUrl: server.baseUrl });
  await dav.put(['a.bin'], new Uint8Array([1, 2, 3]));
  assert.equal(server.calls[0].headers['content-type'], 'application/octet-stream');
});

test('put：非 2xx 抛 WEBDAV_HTTP / WEBDAV_AUTH', async (t) => {
  const failing = await startServer((req, res) => {
    res.writeHead(500);
    res.end();
  });
  t.after(() => failing.close());
  const dav = await createWebDav({ baseUrl: failing.baseUrl });
  await rejectsWithCode(dav.put(['x.zip'], new Uint8Array(1)), 'WEBDAV_HTTP');

  const unauthorized = await startServer((req, res) => {
    res.writeHead(403);
    res.end();
  });
  t.after(() => unauthorized.close());
  const dav2 = await createWebDav({ baseUrl: unauthorized.baseUrl, username: 'u', password: 'p' });
  await rejectsWithCode(dav2.put(['x.zip'], new Uint8Array(1)), 'WEBDAV_AUTH');
});

test('put：bytes 不是 Uint8Array 抛 TypeError', async () => {
  const dav = await createWebDav({ baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(dav.put(['x.zip'], 'a string'), TypeError);
});

// ─── get ───────────────────────────────────────────────────

test('get：返回 bytes 与 etag；404 返回 null', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === '/default/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"abc123"' });
      res.end('{"format":"x"}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  t.after(() => server.close());

  const dav = await createWebDav({ baseUrl: server.baseUrl });
  const found = await dav.get(['default', 'manifest.json'], 1024);
  assert.ok(found !== null);
  assert.deepEqual(Buffer.from(found.bytes), Buffer.from('{"format":"x"}'));
  assert.equal(found.etag, '"abc123"');

  assert.equal(await dav.get(['default', 'missing.json'], 1024), null);
});

test('get：Content-Length 超过 maxBytes 时抛 WEBDAV_TOO_LARGE', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(4096),
    });
    res.end(Buffer.alloc(4096));
  });
  t.after(() => server.close());

  const dav = await createWebDav({ baseUrl: server.baseUrl });
  await assert.rejects(dav.get(['big.bin'], 1024), (error) => {
    assert.equal(error.code, 'WEBDAV_TOO_LARGE');
    assert.match(error.message, /上限/u);
    return true;
  });
});

test('get：没有 Content-Length 的分块响应也会在流式读取时截断', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(Buffer.alloc(64, 0x61));
    res.end(Buffer.alloc(64, 0x62));
  });
  t.after(() => server.close());

  const dav = await createWebDav({ baseUrl: server.baseUrl });
  await rejectsWithCode(dav.get(['chunked.bin'], 100), 'WEBDAV_TOO_LARGE');
});

test('get：500 抛 WEBDAV_HTTP', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(500);
    res.end();
  });
  t.after(() => server.close());
  const dav = await createWebDav({ baseUrl: server.baseUrl });
  await rejectsWithCode(dav.get(['x.bin'], 1024), 'WEBDAV_HTTP');
});

// ─── head ──────────────────────────────────────────────────

test('head：返回 etag；404 返回 null', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === '/default/config.zip') {
      res.writeHead(200, { ETag: '"v42"' });
    } else {
      res.writeHead(404);
    }
    res.end();
  });
  t.after(() => server.close());

  const dav = await createWebDav({ baseUrl: server.baseUrl });
  const found = await dav.head(['default', 'config.zip']);
  assert.deepEqual(found, { etag: '"v42"' });
  assert.equal(await dav.head(['default', 'missing.zip']), null);
  assert.deepEqual(
    server.calls.map((call) => call.method),
    ['HEAD', 'HEAD'],
  );
});

test('head：500 抛 WEBDAV_HTTP', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(503);
    res.end();
  });
  t.after(() => server.close());
  const dav = await createWebDav({ baseUrl: server.baseUrl });
  await rejectsWithCode(dav.head(['x.zip']), 'WEBDAV_HTTP');
});

// ─── 网络 / 超时 / 路径防护 ────────────────────────────────

test('网络错误：连接被拒绝抛 WEBDAV_NETWORK', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200);
    res.end();
  });
  const baseUrl = server.baseUrl;
  await server.close();

  const dav = await createWebDav({ baseUrl, username: 'u', password: 'p', timeoutMs: 2000 });
  await assert.rejects(dav.testConnection(), (error) => {
    assert.equal(error.code, 'WEBDAV_NETWORK');
    assert.match(error.message, /网络错误/u);
    return true;
  });
});

test('超时：服务端不响应时抛 WEBDAV_TIMEOUT', async (t) => {
  const server = await startServer(() => {
    // 故意永不响应
  });
  t.after(() => server.close());

  const dav = await createWebDav({ baseUrl: server.baseUrl, timeoutMs: 250 });
  await assert.rejects(dav.testConnection(), (error) => {
    assert.equal(error.code, 'WEBDAV_TIMEOUT');
    assert.match(error.message, /超时/u);
    return true;
  });
});

test('路径段防遍历：.. / . / 空段 / 含斜杠都在发请求前被拒绝', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200);
    res.end();
  });
  t.after(() => server.close());

  const dav = await createWebDav({ baseUrl: server.baseUrl });
  for (const segments of [
    ['a', '..', 'b'],
    ['..'],
    ['.'],
    [''],
    ['a/b'],
    ['a\\b'],
    [42],
  ]) {
    await assert.rejects(dav.put(segments, new Uint8Array(1)), (error) => {
      assert.ok(
        error instanceof WebDavError || error instanceof TypeError,
        `期望 WebDavError/TypeError，实际：${error}`,
      );
      return true;
    });
  }
  assert.equal(server.calls.length, 0, '非法路径不应发出任何请求');
});
