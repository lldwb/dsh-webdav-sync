/**
 * dsh-webdav-sync —— 应用远端快照（把下载下来的 zip 内容写回本地）。
 *
 * 这一层是整条同步链路里唯一有破坏性的部分，所以规则写得比较死：
 *
 * 1. **所有 zip 条目路径先规范化再校验**：拒绝 `..`、绝对路径、盘符、反斜杠，
 *    并要求解析后的绝对路径仍在目标根目录之内（防路径遍历）。
 * 2. **先备份、后覆盖**：每个将被覆盖的现有文件先复制到
 *    `$DSH_HOME/webdav-sync/backups/<时间戳>/<相对路径>`，备份失败就中止，
 *    绝不在无法回滚的前提下写用户配置。
 * 3. **先写临时文件再 rename**：单文件写入是原子的，不会留下半截配置。
 * 4. **插件包目标目录**：优先写回快照记录的原路径；原路径不可用（换机器、
 *    盘符不存在、无写权限）时退到 `<profileDir>/plugins/<包名>`，并把
 *    profile `package.json` 里的依赖改写成 `link:./plugins/<包名>`，尽量让
 *    恢复后的 profile 自包含。
 *
 * 所有函数都不读取也不修改远端状态；编排（下载、校验、写状态）在 index.js。
 *
 * @module dsh-webdav-sync/lib/apply
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeRelativeZipPath } from './snapshot.mjs';

/** 备份目录名的时间戳格式：2026-10-18T11-22-33-456Z（可直接按字典序排序）。 */
function backupStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, '-');
}

/**
 * 把一个 zip 相对路径解析到某个目标根之下，并证明它没有逃出该根。
 *
 * @param {string} targetRoot 目标根目录（绝对路径）。
 * @param {string} relative 已规范化的 zip 相对路径（正斜杠）。
 * @returns {string} 目标绝对路径。
 * @throws {Error} 路径逃出目标根时抛错。
 */
export function resolveInsideRoot(targetRoot, relative) {
  const normalized = normalizeRelativeZipPath(relative);
  const root = path.resolve(targetRoot);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(withSep)) {
    throw new Error(`拒绝写入目标根之外的路径: ${relative}`);
  }
  return resolved;
}

/**
 * 原子写入一个文件：先写同目录的临时文件，再 rename 覆盖。
 *
 * @param {string} target 目标文件绝对路径。
 * @param {Uint8Array} bytes 文件内容。
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(target, bytes) {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 收集一份「目标文件是否已存在」的清单，并把存在的文件复制进备份目录。
 *
 * @param {Array<{ target: string, backupPath: string }>} targets
 *   目标绝对路径与它在备份目录里的相对路径。
 * @param {string} backupDir 本次备份的根目录。
 * @returns {Promise<{ backupDir: string, backedUp: number }>}
 */
export async function backupExistingFiles(targets, backupDir) {
  let backedUp = 0;
  for (const { target, backupPath } of targets) {
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      continue; // 不存在就无需备份
    }
    if (!stat.isFile()) continue;
    const destination = resolveInsideRoot(backupDir, backupPath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(target, destination);
    backedUp += 1;
  }
  return { backupDir, backedUp };
}

/**
 * 只保留最近 `keep` 份备份目录，删掉更早的。
 *
 * @param {string} backupsRoot 备份根目录。
 * @param {number} keep 保留份数（至少 1）。
 * @returns {Promise<number>} 删除的份数。
 */
export async function pruneBackups(backupsRoot, keep) {
  let names;
  try {
    names = await fs.readdir(backupsRoot);
  } catch {
    return 0;
  }
  const keepCount = Math.max(1, Number.isFinite(keep) ? Math.trunc(keep) : 5);
  const stamps = names.filter((name) => /^\d{4}-\d{2}-\d{2}T/u.test(name)).sort();
  let removed = 0;
  for (const name of stamps.slice(0, Math.max(0, stamps.length - keepCount))) {
    await fs.rm(path.join(backupsRoot, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * 判断一个插件包应当恢复到哪个目录。
 *
 * 规则：先尝试原路径（创建父目录 + 包根目录）；失败则退到 profile 下的
 * `plugins/<包名>`。返回目标目录与是否回退。
 *
 * @param {string} originalDir 快照里记录的原目录（绝对路径）。
 * @param {string} fallbackDir profile 内的回退目录。
 * @returns {Promise<{ dir: string, fallback: boolean }>}
 */
async function pickPluginTarget(originalDir, fallbackDir) {
  const candidates = [];
  if (typeof originalDir === 'string' && originalDir.trim().length > 0) {
    candidates.push({ dir: path.resolve(originalDir), fallback: false });
  }
  candidates.push({ dir: path.resolve(fallbackDir), fallback: true });
  let lastError;
  for (const candidate of candidates) {
    try {
      await fs.mkdir(candidate.dir, { recursive: true });
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('没有可用的插件目标目录');
}

/**
 * 把 profile `package.json` 中的某个本地依赖改写成 profile 内相对路径。
 *
 * @param {string} profileDir profile 目录。
 * @param {string} name 包名。
 * @param {string} relativeSpec 形如 `./plugins/<包名>`。
 * @returns {Promise<boolean>} 是否真的改写了文件。
 */
async function rewriteLocalDependency(profileDir, name, relativeSpec) {
  const file = path.join(profileDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return false;
  }
  if (manifest === null || typeof manifest !== 'object') return false;
  const dependencies = manifest.dependencies;
  if (dependencies === null || typeof dependencies !== 'object' || !Object.hasOwn(dependencies, name)) {
    return false;
  }
  const nextSpec = `link:${relativeSpec}`;
  if (dependencies[name] === nextSpec) return false;
  dependencies[name] = nextSpec;
  await writeFileAtomic(file, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  return true;
}

/**
 * 应用一份远端快照。
 *
 * 输入都是内存里的 zip 条目（由 `zipRead` 解出），因此本函数不负责下载与
 * 校验远端 hash——那两步在 index.js 里、写入之前完成。
 *
 * @param {object} input
 * @param {Array<{ name: string, bytes: Uint8Array }>} input.configEntries config.zip 条目。
 * @param {Array<{ name: string, bytes: Uint8Array }>} input.pluginEntries plugins.zip 条目。
 * @param {Array<{ name: string, originalDir: string }>} input.pluginList `_plugins.json` 的内容。
 * @param {string} input.profileDir 当前 profile 目录。
 * @param {string} input.dshHome DSH 主目录。
 * @param {string} input.backupsRoot 备份根目录。
 * @param {number} input.backupKeep 备份保留份数。
 * @returns {Promise<{ backupDir: string, backedUp: number, written: number, plugins: Array<object>, warnings: string[] }>}
 */
export async function applySnapshot(input) {
  const { profileDir, dshHome, backupsRoot, backupKeep } = input;
  const configEntries = Array.isArray(input.configEntries) ? input.configEntries : [];
  const pluginEntries = Array.isArray(input.pluginEntries) ? input.pluginEntries : [];
  const pluginList = Array.isArray(input.pluginList) ? input.pluginList : [];

  const warnings = [];
  const stamp = backupStamp();
  const backupDir = path.join(backupsRoot, stamp);

  // ── 1. 先算出所有目标路径（配置 + 插件），一次性做路径校验与备份 ──
  const configTargets = [];
  for (const entry of configEntries) {
    const name = normalizeRelativeZipPath(entry.name);
    const [scope, ...rest] = name.split('/');
    if (scope !== 'profile' && scope !== 'home') {
      warnings.push(`忽略未知作用域的配置条目: ${entry.name}`);
      continue;
    }
    if (rest.length === 0) {
      warnings.push(`忽略空配置条目: ${entry.name}`);
      continue;
    }
    const root = scope === 'profile' ? profileDir : dshHome;
    configTargets.push({
      entry,
      target: resolveInsideRoot(root, rest.join('/')),
      backupPath: name,
    });
  }

  const pluginTargets = [];
  const pluginSummary = [];
  const byName = new Map(pluginList.map((item) => [item?.name, item]));
  for (const entry of pluginEntries) {
    const name = normalizeRelativeZipPath(entry.name);
    if (name === '_plugins.json') continue;
    const [packageName, ...rest] = name.split('/');
    if (rest.length === 0) {
      warnings.push(`忽略插件包顶层条目: ${entry.name}`);
      continue;
    }
    const declared = byName.get(packageName);
    if (declared === undefined) {
      warnings.push(`跳过未在 _plugins.json 声明的插件文件: ${entry.name}`);
      continue;
    }
    pluginTargets.push({ entry, packageName, relative: rest.join('/'), declared });
  }

  // 插件包按包名归组，先决定每个包的最终目标目录
  const packageTargets = new Map();
  for (const target of pluginTargets) {
    if (packageTargets.has(target.packageName)) continue;
    const originalDir = typeof target.declared.originalDir === 'string' ? target.declared.originalDir : '';
    const fallbackDir = path.join(profileDir, 'plugins', target.packageName);
    const picked = await pickPluginTarget(originalDir, fallbackDir);
    packageTargets.set(target.packageName, {
      dir: picked.dir,
      fallback: picked.fallback,
      originalDir,
    });
  }

  // ── 2. 备份所有将被覆盖的现有文件 ──
  const backupTargets = [
    ...configTargets.map((item) => ({ target: item.target, backupPath: item.backupPath })),
    ...pluginTargets.map((item) => {
      const packageTarget = packageTargets.get(item.packageName);
      return {
        target: resolveInsideRoot(packageTarget.dir, item.relative),
        backupPath: `plugins/${item.packageName}/${item.relative}`,
      };
    }),
  ];
  const { backedUp } = await backupExistingFiles(backupTargets, backupDir);

  // ── 3. 写配置文件 ──
  let written = 0;
  for (const item of configTargets) {
    await writeFileAtomic(item.target, item.entry.bytes);
    written += 1;
  }

  // ── 4. 写插件包文件 ──
  for (const item of pluginTargets) {
    const packageTarget = packageTargets.get(item.packageName);
    const target = resolveInsideRoot(packageTarget.dir, item.relative);
    await writeFileAtomic(target, item.entry.bytes);
    written += 1;
  }

  // ── 5. 回退到 profile 内目录的插件：改写依赖为相对 link ──
  for (const [name, target] of packageTargets) {
    const relativeSpec = `./${path.posix.join('plugins', name)}`;
    if (target.fallback) {
      const rewritten = await rewriteLocalDependency(profileDir, name, relativeSpec).catch((error) => {
        warnings.push(`改写 profile 依赖失败（${name}）: ${error?.message ?? error}`);
        return false;
      });
      if (rewritten) {
        warnings.push(`插件 ${name} 已改写到 ${relativeSpec}，需要重启 DSH 并重新安装依赖后才生效`);
      }
    }
    pluginSummary.push({
      name,
      dir: target.dir,
      fallback: target.fallback,
      originalDir: target.originalDir,
    });
  }

  // ── 6. 清理过期备份 ──
  await pruneBackups(backupsRoot, backupKeep).catch(() => 0);

  return { backupDir, backedUp, written, plugins: pluginSummary, warnings };
}

/**
 * 从 plugins.zip 条目里取出 `_plugins.json`；缺失时返回空数组。
 *
 * @param {Array<{ name: string, bytes: Uint8Array }>} pluginEntries
 * @returns {Array<{ name: string, originalDir: string }>}
 */
export function readPluginList(pluginEntries) {
  const entry = pluginEntries.find((item) => normalizeRelativeZipPath(item.name) === '_plugins.json');
  if (entry === undefined) return [];
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(entry.bytes).toString('utf8'));
  } catch (error) {
    throw new Error(`_plugins.json 不是合法 JSON: ${error?.message ?? error}`);
  }
  if (!Array.isArray(parsed)) throw new Error('_plugins.json 必须是数组');
  return parsed
    .filter((item) => item !== null && typeof item === 'object' && typeof item.name === 'string' && item.name.length > 0)
    .map((item) => ({
      name: item.name,
      originalDir: typeof item.originalDir === 'string' ? item.originalDir : '',
    }));
}
