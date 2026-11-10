/**
 * 「内置插件配置」卡片插画的一致性单测。
 *
 * 背景：DSH 插件页的整卡插画由随附的 plugin-manager 客户端写死了一张映射表
 * （只有 shell / agent-loop / subagent / web-search 四个官方 id），第三方插件没有
 * 声明入口。唯一通道是 `globalThis.__DSH_PLUGIN_ITEM_ARTWORK__` 这个全局注册表：
 * client.js 把包根 `icon.svg` 的字节以 data URI 登记进去，随附 bundle 的查询逻辑
 * 由 dsh-plugin-devkit 的 `scripts/patch-plugin-item-artwork.mjs` 补上。
 *
 * 本文件盯住三件事，防止「改了图标忘同步」「注册代码被删了却没人发现」：
 *
 * 1. `ITEM_ARTWORK_URI` 与包根 `icon.svg` 逐字节一致；
 * 2. `icon.svg` 满足 readPluginMeta 的准入（≤256 KiB、36×36 viewBox、无外部引用）；
 * 3. `registerItemArtwork()` 真的写/删全局注册表，且注销时不误删同 id 的后来者。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, '..');
const clientPath = path.join(packageRoot, 'client.js');
const iconPath = path.join(packageRoot, 'icon.svg');

/** 槽位 id：与 Host 行的设置命名空间同名，也是插画注册键。 */
const SLOT_ID = 'webdav-sync';

/** 图标准入上限，与 `readPluginMeta` 的 MAX_ICON_BYTES 一致。 */
const MAX_ICON_BYTES = 256 * 1024;

const clientSource = readFileSync(clientPath, 'utf8');
const iconBytes = readFileSync(iconPath);
const expectedUri = `data:image/svg+xml;base64,${iconBytes.toString('base64')}`;

/**
 * 从 client.js 里按大括号配对切出一个函数源码。
 *
 * 只用于测试：不想把整个 ModuleLoader bundle 跑起来（各插件的假 ctx 差异太大），
 * 但想真执行注册函数本身，所以按源码切出来在 vm 里跑。
 *
 * @param {string} source - client.js 全文。
 * @param {string} name - 函数名。
 * @returns {string} 含 `function name() { ... }` 的源码片段。
 */
function extractFunction(source, name) {
  const signature = `function ${name}() {`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `client.js 必须定义 ${name}()`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name}() 的大括号不配对`);
}

/**
 * 在独立 vm 上下文里造出注册函数（常量按 client.js 里的真实值注入）。
 *
 * @returns {{ register: () => () => void, sandbox: object }} 注册函数与它的全局对象。
 */
function loadRegister() {
  const uri = /const ITEM_ARTWORK_URI =\s*\n?\s*'([^']*)';/.exec(clientSource)?.[1];
  assert.equal(typeof uri, 'string', 'client.js 里必须有 ITEM_ARTWORK_URI 赋值');
  const sandbox = {};
  vm.createContext(sandbox);
  const factorySource = [
    '(function () {',
    `  const ITEM_ARTWORK_ID = '${SLOT_ID}';`,
    `  const ITEM_ARTWORK_URI = ${`${JSON.stringify(uri)}`};`,
    extractFunction(clientSource, 'registerItemArtwork'),
    '  return registerItemArtwork;',
    '})()',
  ].join('\n');
  const register = vm.runInContext(factorySource, sandbox, { filename: 'client-artwork.js' });
  assert.equal(typeof register, 'function');
  return { register, sandbox, uri };
}

test('client.js 用槽位 id 作为插画注册键', () => {
  assert.ok(
    clientSource.includes(`const ITEM_ARTWORK_ID = '${SLOT_ID}';`),
    'ITEM_ARTWORK_ID 必须等于 plugins.item 槽位 id',
  );
});

test('ITEM_ARTWORK_URI 与包根 icon.svg 逐字节一致', () => {
  const match = /const ITEM_ARTWORK_URI =\s*\n?\s*'([^']*)';/.exec(clientSource);
  assert.ok(match, '必须能找到 ITEM_ARTWORK_URI 赋值');
  assert.equal(match[1], expectedUri, '改图标后要重跑 embed-plugin-artwork.mjs');
});

test('apply 在注入 effect 里登记卡片插画', () => {
  assert.ok(
    clientSource.includes(`ctx.effect(() => registerItemArtwork(), 'dsh-webdav-sync: 卡片插画');`),
    'apply() 必须用 ctx.effect 登记插画，随插件卸载回滚',
  );
});

test('icon.svg 满足 readPluginMeta 准入：≤256 KiB、36×36 viewBox、无外部引用', () => {
  assert.ok(iconBytes.length > 0, 'icon.svg 不能为空');
  assert.ok(iconBytes.length <= MAX_ICON_BYTES, `icon.svg 超过 ${MAX_ICON_BYTES} 字节`);
  const text = iconBytes.toString('utf8');
  assert.match(text, /viewBox="0 0 36 36"/u, '官方 artwork 都是 36×36 viewBox');
  assert.match(text, /width="36"/u);
  assert.match(text, /height="36"/u);
  assert.equal(text.includes('<script'), false, 'icon.svg 不能含脚本');
  assert.equal(text.includes('<image'), false, 'icon.svg 不能引用位图');
  assert.equal(/(?:xlink:)?href="(?!#)[^"]*"/u.test(text.replace(/xmlns="[^"]*"/gu, '')), false, 'icon.svg 不能有外部引用');
});

test('registerItemArtwork 写入全局注册表，注销时删掉自己那条', () => {
  const { register, sandbox, uri } = loadRegister();
  const dispose = register();
  assert.equal(typeof dispose, 'function');
  const registry = sandbox.__DSH_PLUGIN_ITEM_ARTWORK__;
  assert.equal(typeof registry, 'object');
  assert.equal(registry[SLOT_ID], uri, '注册值必须是 icon.svg 的 data URI');
  dispose();
  assert.equal(SLOT_ID in registry, false, '注销后不留键');
});

test('重复注册幂等，注销不会误删同 id 的后来者', () => {
  const { register, sandbox, uri } = loadRegister();
  const disposeFirst = register();
  const disposeSecond = register();
  assert.equal(sandbox.__DSH_PLUGIN_ITEM_ARTWORK__[SLOT_ID], uri);
  // 后来者（例如重装/热更后的另一个实例）覆盖了同一个键：旧实例的注销不能把它删掉。
  sandbox.__DSH_PLUGIN_ITEM_ARTWORK__[SLOT_ID] = 'data:image/svg+xml;base64,bGF0ZXI=';
  disposeFirst();
  disposeSecond();
  assert.equal(
    sandbox.__DSH_PLUGIN_ITEM_ARTWORK__[SLOT_ID],
    'data:image/svg+xml;base64,bGF0ZXI=',
    '后来者还在时，旧实例的注销不能清空注册表',
  );
});
