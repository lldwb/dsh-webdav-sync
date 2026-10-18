/**
 * WebDAV 传输层：全局 fetch + AbortSignal.timeout，零第三方依赖。
 *
 * 只覆盖同步用到的五个动作：PROPFIND 探活、逐级 MKCOL、PUT、GET、HEAD。
 * 所有 URL 路径段都单独 encodeURIComponent，错误信息统一脱敏（绝不带密码）。
 * 对坚果云（jianguoyun.com / nutstore）的 401/403 与 MKCOL 冲突给出针对性提示。
 *
 * 错误码：
 * - `WEBDAV_INVALID_URL`：地址或路径段不合法
 * - `WEBDAV_AUTH`：401 / 403（凭据或权限问题）
 * - `WEBDAV_HTTP`：其它非 2xx 状态
 * - `WEBDAV_NETWORK`：DNS / 连接 / TLS / 读响应失败
 * - `WEBDAV_TIMEOUT`：超过 timeoutMs
 * - `WEBDAV_TOO_LARGE`：GET 响应体超过 maxBytes
 *
 * @module dsh-webdav-sync/lib/webdav
 */

/** 默认请求超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** GET 默认响应体上限：64 MiB。 */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * WebDAV 操作错误。`code` 供 RPC 层直接映射错误码，`message` 可直接展示给用户。
 */
export class WebDavError extends Error {
  /**
   * @param {string} message 给用户看的中文错误信息
   * @param {string} [code] 错误码
   */
  constructor(message, code = 'WEBDAV_HTTP') {
    super(message);
    this.name = 'WebDavError';
    this.code = code;
  }
}

/**
 * 校验并规范化 WebDAV 根地址。
 *
 * - 只接受 http/https；
 * - 去掉尾部所有 `/`；
 * - 拒绝内嵌用户名密码（凭据应该走独立字段，避免泄漏进日志/错误）；
 * - 拒绝查询参数与 `#` 片段（它们会和追加的路径段冲突）。
 *
 * @param {string} raw
 * @returns {string} 规范化后的地址，例如 `https://dav.jianguoyun.com/dav`
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') {
    throw new WebDavError('WebDAV 地址不能为空', 'WEBDAV_INVALID_URL');
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new WebDavError('WebDAV 地址不能为空', 'WEBDAV_INVALID_URL');
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new WebDavError(`WebDAV 地址无效：${error.message}`, 'WEBDAV_INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebDavError('WebDAV 仅支持 http/https 地址', 'WEBDAV_INVALID_URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebDavError(
      'WebDAV 地址不能内嵌用户名或密码，请填写到用户名 / 密码字段',
      'WEBDAV_INVALID_URL',
    );
  }
  if (url.search !== '') {
    throw new WebDavError('WebDAV 地址不能包含查询参数（?…），请只填写目录地址', 'WEBDAV_INVALID_URL');
  }
  if (url.hash !== '') {
    throw new WebDavError('WebDAV 地址不能包含 # 片段，请只填写目录地址', 'WEBDAV_INVALID_URL');
  }

  let pathname = url.pathname || '/';
  pathname = pathname === '/' ? '' : pathname.replace(/\/+$/u, '');
  return `${url.origin}${pathname}`;
}

/**
 * 组装 Basic Auth 请求头；用户名为空时返回 null（匿名访问）。
 *
 * @param {string} username
 * @param {string} password
 * @returns {string|null}
 */
export function basicAuthHeader(username, password) {
  const user = typeof username === 'string' ? username.trim() : '';
  if (user === '') return null;
  const secret = typeof password === 'string' ? password : '';
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
}

/**
 * 创建 WebDAV 客户端。
 *
 * @param {{ baseUrl: string, username?: string, password?: string, timeoutMs?: number }} options
 * @returns {Promise<{
 *   testConnection: () => Promise<void>,
 *   ensureDirectories: (segments: string[]) => Promise<void>,
 *   put: (segments: string[], bytes: Uint8Array, contentType?: string) => Promise<void>,
 *   get: (segments: string[], maxBytes?: number) => Promise<{bytes: Uint8Array, etag: string|null}|null>,
 *   head: (segments: string[]) => Promise<{etag: string|null}|null>,
 * }>}
 */
export async function createWebDav(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createWebDav 的 options 必须是对象');
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const authHeader = basicAuthHeader(options.username, options.password);

  /** 判断某个 URL 是否指向坚果云（用于追加针对性提示）。 */
  function isJianguoyunUrl(urlString) {
    try {
      const hostname = new URL(urlString).hostname.toLowerCase();
      return hostname.includes('jianguoyun.com') || hostname.includes('nutstore');
    } catch {
      return false;
    }
  }

  /** 脱敏 URL：去掉 userinfo、查询参数与片段，只保留可用于诊断的 origin + path。 */
  function redactUrl(raw) {
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return String(raw);
    }
  }

  function formatBytes(value) {
    if (value >= 1024 * 1024) return `${value} 字节（约 ${(value / 1024 / 1024).toFixed(1)} MiB）`;
    if (value >= 1024) return `${value} 字节（约 ${(value / 1024).toFixed(1)} KiB）`;
    return `${value} 字节`;
  }

  /** 把非 2xx 状态码转成带服务商提示的错误。 */
  function statusError(op, status, url) {
    const safeUrl = redactUrl(url);
    const jianguoyun = isJianguoyunUrl(url);
    const code = status === 401 || status === 403 ? 'WEBDAV_AUTH' : 'WEBDAV_HTTP';
    let message = `WebDAV ${op} 失败：HTTP ${status}（${safeUrl}）`;

    if (status === 401 || status === 403) {
      message += jianguoyun
        ? '。坚果云请使用「第三方应用密码」（网页端 → 账户信息 → 安全选项 → 添加应用密码），并确认地址指向 /dav/ 下的目录。'
        : '。请检查 WebDAV 用户名、密码及目录读写权限。';
    } else if (jianguoyun && status === 404) {
      message += '。坚果云常见原因：地址不在 /dav/ 可写目录下，或尚未在网页端创建该文件夹。';
    } else if (op === 'MKCOL' && status === 409) {
      message += jianguoyun
        ? '。坚果云不允许自动创建顶层文件夹，请先在网页端手动创建远端根目录后重试。'
        : '。请确认上级目录存在且服务端允许创建目录。';
    }
    return new WebDavError(message, code);
  }

  /** 把 fetch 抛出的异常转成脱敏的 WebDavError。 */
  function transportError(op, url, error) {
    const safeUrl = redactUrl(url);
    const name = error?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError' || error?.code === 'ABORT_ERR') {
      return new WebDavError(`WebDAV ${op} 请求超时（${timeoutMs}ms）：${safeUrl}`, 'WEBDAV_TIMEOUT');
    }
    const detail = error?.cause?.message ?? error?.message ?? String(error);
    return new WebDavError(`WebDAV ${op} 请求失败（网络错误：${detail}）：${safeUrl}`, 'WEBDAV_NETWORK');
  }

  /** 校验路径段：不允许空段、`.`、`..`、斜杠（防路径遍历/逃逸）。 */
  function normalizeSegments(segments) {
    if (!Array.isArray(segments)) {
      throw new TypeError('WebDAV 路径段必须是字符串数组');
    }
    return segments.map((segment, index) => {
      if (typeof segment !== 'string') {
        throw new TypeError(`WebDAV 第 ${index + 1} 个路径段必须是字符串`);
      }
      if (segment === '') {
        throw new WebDavError('WebDAV 路径段不能为空', 'WEBDAV_INVALID_URL');
      }
      if (segment === '.' || segment === '..') {
        throw new WebDavError(
          `WebDAV 路径段不能是 "." 或 ".."（防路径遍历）：${segment}`,
          'WEBDAV_INVALID_URL',
        );
      }
      if (segment.includes('/') || segment.includes('\\')) {
        throw new WebDavError(
          `WebDAV 路径段不能包含斜杠：${segment}`,
          'WEBDAV_INVALID_URL',
        );
      }
      return segment;
    });
  }

  /** 由 baseUrl + 路径段拼出目标 URL；每段单独 encodeURIComponent。 */
  function targetUrl(segments, { directory = false } = {}) {
    const list = normalizeSegments(segments);
    let path = list.map((segment) => encodeURIComponent(segment)).join('/');
    if (path !== '') path = `/${path}`;
    if (directory && path !== '') path += '/';
    return `${baseUrl}${path}`;
  }

  /** 主动丢弃响应体，避免连接池里挂着未消费的 body。 */
  async function discardBody(response) {
    if (!response.body) return;
    try {
      await response.body.cancel();
    } catch {
      // 响应体已被消费或连接已关闭，忽略。
    }
  }

  /** 发请求并统一处理网络/超时错误。 */
  async function request(method, url, { headers = {}, body, op } = {}) {
    const requestHeaders = { ...headers };
    if (authHeader !== null) requestHeaders.Authorization = authHeader;
    try {
      return await fetch(url, {
        method,
        headers: requestHeaders,
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    } catch (error) {
      throw transportError(op ?? method, url, error);
    }
  }

  function tooLargeError(maxBytes, safeUrl) {
    return new WebDavError(
      `WebDAV GET 响应体超过上限（${formatBytes(maxBytes)}）：${safeUrl}`,
      'WEBDAV_TOO_LARGE',
    );
  }

  /** 流式读取响应体，边读边检查 maxBytes，避免大文件撑爆内存。 */
  async function readBodyLimited(response, maxBytes, url) {
    const safeUrl = redactUrl(url);
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const declared = Number.parseInt(contentLength, 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await discardBody(response);
        throw tooLargeError(maxBytes, safeUrl);
      }
    }
    if (!response.body) return new Uint8Array(0);

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // 取消失败不影响已确定的错误。
          }
          throw tooLargeError(maxBytes, safeUrl);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof WebDavError) throw error;
      const name = error?.name ?? '';
      if (name === 'TimeoutError' || name === 'AbortError' || error?.code === 'ABORT_ERR') {
        throw new WebDavError(`WebDAV GET 读取响应超时（${timeoutMs}ms）：${safeUrl}`, 'WEBDAV_TIMEOUT');
      }
      throw new WebDavError(
        `WebDAV GET 读取响应失败（网络错误：${error?.message ?? String(error)}）：${safeUrl}`,
        'WEBDAV_NETWORK',
      );
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  /**
   * 探活：对根地址发 PROPFIND Depth:0，2xx（含 207）视为成功。
   * @returns {Promise<void>}
   */
  async function testConnection() {
    const url = baseUrl === '' ? '/' : `${baseUrl}/`;
    const response = await request('PROPFIND', url, { headers: { Depth: '0' }, op: 'PROPFIND' });
    const status = response.status;
    await discardBody(response);
    if (status >= 200 && status < 300) return;
    throw statusError('PROPFIND', status, url);
  }

  /**
   * 逐级创建远端目录（URL 末尾补 `/`）。405（已存在）与 409（父目录已建好）视为成功。
   * @param {string[]} segments
   * @returns {Promise<void>}
   */
  async function ensureDirectories(segments) {
    const list = normalizeSegments(segments);
    if (list.length === 0) return; // 根目录本身无需创建
    for (let depth = 1; depth <= list.length; depth += 1) {
      const url = targetUrl(list.slice(0, depth), { directory: true });
      const response = await request('MKCOL', url, { op: 'MKCOL' });
      const status = response.status;
      await discardBody(response);
      if (status >= 200 && status < 300) continue;
      if (status === 405 || status === 409) continue; // 已存在
      throw statusError('MKCOL', status, url);
    }
  }

  /**
   * 上传文件。
   * @param {string[]} segments
   * @param {Uint8Array} bytes
   * @param {string} [contentType]
   * @returns {Promise<void>}
   */
  async function put(segments, bytes, contentType = 'application/octet-stream') {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('put 的 bytes 必须是 Uint8Array 或 Buffer');
    }
    const url = targetUrl(segments);
    const response = await request('PUT', url, {
      headers: { 'Content-Type': contentType || 'application/octet-stream' },
      body: bytes,
      op: 'PUT',
    });
    const status = response.status;
    await discardBody(response);
    if (status >= 200 && status < 300) return;
    throw statusError('PUT', status, url);
  }

  /**
   * 下载文件。404 返回 null；超过 maxBytes 抛 WEBDAV_TOO_LARGE。
   * @param {string[]} segments
   * @param {number} [maxBytes]
   * @returns {Promise<{bytes: Uint8Array, etag: string|null}|null>}
   */
  async function get(segments, maxBytes = DEFAULT_MAX_BYTES) {
    const limit =
      Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
    const url = targetUrl(segments);
    const response = await request('GET', url, { op: 'GET' });
    const status = response.status;
    if (status === 404) {
      await discardBody(response);
      return null;
    }
    if (status < 200 || status >= 300) {
      await discardBody(response);
      throw statusError('GET', status, url);
    }
    const bytes = await readBodyLimited(response, limit, url);
    return { bytes, etag: response.headers.get('etag') ?? null };
  }

  /**
   * 读取远端文件的 ETag（不下载内容）。404 返回 null。
   * @param {string[]} segments
   * @returns {Promise<{etag: string|null}|null>}
   */
  async function head(segments) {
    const url = targetUrl(segments);
    const response = await request('HEAD', url, { op: 'HEAD' });
    const status = response.status;
    await discardBody(response);
    if (status === 404) return null;
    if (status >= 200 && status < 300) {
      return { etag: response.headers.get('etag') ?? null };
    }
    throw statusError('HEAD', status, url);
  }

  return { testConnection, ensureDirectories, put, get, head };
}
