/**
 * dsh-webdav-sync —— 应用远端快照（把下载下来的 zip 内容写回本地）。
 *
 * 这一层是整条同步链路里唯一有破坏性的部分，所以安全规则写得比较死：
 *
 * 1. **配置条目白名单**：profile 只允许写 `PROFILE_CONFIG_FILES` 里的文件，home
 *    只允许写 `HOME_CONFIG_FILES` 里的文件。zip 里其它路径（`node_modules/`、
 *    `sessions/`、`attachments/` 之类）一律忽略并记 warning——远端快照不能把
 *    任意文件塞进 DSH 主目录。
 * 2. **路径双重校验**：先做字符串级校验（拒绝 `..`、绝对路径、盘符、UNC、
 *    Windows 设备名与 ADS 冒号），再用 `realpath` 解析目标父目录，证明它仍在
 *    目标根的规范路径之内。只做字符串前缀检查会被 Windows junction/symlink 绕过
 *    （profile 的 `node_modules/` 正是 pnpm link 产生的 junction）。
 * 3. **先备份、后覆盖**：每个将被覆盖的现有文件先复制到
 *    `$DSH_HOME/webdav-sync/backups/<时间戳>/<相对路径>`；备份失败立即中止。
 * 4. **先写临时文件再 rename**：单文件写入是原子的。
 * 5. **插件目标只信本地 profile 的依赖声明**：`_plugins.json` 里的 `originalDir`
 *    是远端可控数据，**不直接采用**；写回位置取自本次恢复后 profile
 *    `package.json` 里该包名的 `link:` / `file:` 路径（且必须是已存在目录、不在
 *    系统目录下）。否则退到 `<profile>/plugins/<包名>`，并把依赖改写成相对 link。
 * 6. **单个文件写入失败不中断整次恢复**：记 warning 继续写其余文件，最后在结果里
 *    报告；致命错误（备份失败、目标根逃逸）才中止。
 *
 * @module dsh-webdav-sync/lib/apply
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeRelativeZipPath } from './snapshot.mjs';

/** profile 目录里允许被远端快照写入的配置文件。 */
export const ALLOWED_PROFILE_FILES = new Set([
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]);

/** `$DSH_HOME` 根目录里允许被远端快照写入的配置文件。 */
export const ALLOWED_HOME_FILES = new Set(['.credentials.yaml', 'settings.yaml', 'settings.json']);

/** 凭据文件名（`syncCredentials=false` 的机器不接受远端写回它）。 */
export const CREDENTIALS_FILE_NAME = '.credentials.yaml';

/** 插件的回退目录名（位于 profile 内）。 */
export const FALLBACK_PLUGIN_DIR = 'plugins';

/** 带稳定错误码的应用层错误。 */
export class ApplyError extends Error {
  /**
   * @param {string} message 面向用户的中文错误信息。
   * @param {string} code 稳定错误码。
   */
  constructor(message, code) {
    super(message);
    this.name = 'ApplyError';
    this.code = code;
  }
}

/** 备份目录名的时间戳格式：2026-10-18T11-22-33-456Z（可直接按字典序排序）。 */
function backupStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, '-');
}

/**
 * 解析一个路径的规范形式；末尾不存在的部分先记下来，拼到最近已存在祖先的
 * realpath 后面。等价于 `@deepseek-ai/dsh-home-paths` 的 canonicalizeWatchPath，
 * 但这里只读、不改。
 *
 * @param {string} target 绝对路径（可以不存在）。
 * @returns {Promise<string>} 规范绝对路径。
 */
async function canonicalRealPath(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** 判断 candidate 是否等于 parent 或位于其下（case-insensitive on Windows）。 */
export function isInsideRealPath(parentReal, candidateReal) {
  const parent = process.platform === 'win32' ? parentReal.toLowerCase() : parentReal;
  const candidate = process.platform === 'win32' ? candidateReal.toLowerCase() : candidateReal;
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 把一个 zip 相对路径解析到某个目标根之下，并做字符串级防逃逸校验。
 *
 * @param {string} targetRoot 目标根目录（绝对路径）。
 * @param {string} relative 已规范化的 zip 相对路径（正斜杠）。
 * @returns {string} 目标绝对路径。
 * @throws {ApplyError} 路径逃出目标根时抛错。
 */
export function resolveInsideRoot(targetRoot, relative) {
  const normalized = normalizeRelativeZipPath(relative);
  const root = path.resolve(targetRoot);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(withSep)) {
    throw new ApplyError(`拒绝写入目标根之外的路径: ${relative}`, 'PATH_ESCAPE');
  }
  return resolved;
}

/**
 * 为一次写入准备目标：先证明「目标父目录的最近已存在祖先」的规范路径仍在目标根内，
 * 再创建目录，最后再对真实父目录做一次 realpath 校验。
 *
 * 两步校验的顺序很重要：如果先 mkdir 再校验，junction/symlink 逃逸时已经会在
 * 目标根之外创建空目录；先在最近已存在祖先上校验可以避免这个副作用。
 *
 * @param {string} root 目标根（绝对路径）。
 * @param {string} target 已通过字符串校验的目标绝对路径。
 * @returns {Promise<void>}
 * @throws {ApplyError} 父目录真实路径逃出目标根时抛错。
 */
async function prepareWriteTarget(root, target) {
  const realRoot = await canonicalRealPath(root);
  const parent = path.dirname(target);
  const realParentCandidate = await canonicalRealPath(parent);
  if (!isInsideRealPath(realRoot, realParentCandidate)) {
    throw new ApplyError(`拒绝写入目标根之外的位置（reparse point 逃逸）: ${target}`, 'PATH_ESCAPE');
  }
  await fs.mkdir(parent, { recursive: true });
  const realParent = await fs.realpath(parent);
  if (!isInsideRealPath(realRoot, realParent)) {
    throw new ApplyError(`拒绝写入目标根之外的位置（reparse point 逃逸）: ${target}`, 'PATH_ESCAPE');
  }
}

/**
 * 原子写入一个文件：先写同目录临时文件，再 rename 覆盖。
 *
 * @param {string} target 目标文件绝对路径（调用方需先通过 prepareWriteTarget）。
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
 * 收集「目标文件是否已存在」的清单，并把存在的文件复制进备份目录。
 *
 * @param {Array<{ target: string, backupPath: string }>} targets 目标绝对路径与备份相对路径。
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
    await prepareWriteTarget(backupDir, destination);
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
 * 系统目录与用户敏感目录黑名单：插件包不允许写回这些位置（即使本地依赖声明
 * 这么写）。这里用 realpath 比较，junction 指向系统目录时也能识别。
 *
 * @param {string} dir 目标目录绝对路径。
 * @param {string} [dshHome] DSH 主目录（其根目录本身不允许作为插件目录）。
 * @returns {Promise<boolean>} 命中黑名单时 true。
 */
export async function isForbiddenPluginRoot(dir, dshHome) {
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) === resolved) return true; // 盘符根 / 文件系统根
  let real = resolved;
  try {
    real = await canonicalRealPath(resolved);
  } catch {
    // 解析失败时按原始路径保守判断。
  }
  const forbidden = [];
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) forbidden.push(process.env.SystemRoot);
    if (process.env.ProgramFiles) forbidden.push(process.env.ProgramFiles);
    if (process.env['ProgramFiles(x86)']) forbidden.push(process.env['ProgramFiles(x86)']);
    if (process.env.ProgramData) forbidden.push(process.env.ProgramData);
    forbidden.push('C:\\Windows');
    const home = process.env.USERPROFILE;
    if (home) {
      forbidden.push(
        path.join(home, 'Desktop'),
        path.join(home, 'Documents'),
        path.join(home, 'Downloads'),
        path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu'),
        path.join(home, 'AppData', 'Local', 'Microsoft', 'Windows', 'Start Menu'),
        path.join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps'),
      );
    }
  } else {
    forbidden.push('/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/var');
  }
  if (typeof dshHome === 'string' && dshHome.length > 0) {
    forbidden.push(path.resolve(dshHome));
  }
  for (const root of forbidden) {
    if (typeof root !== 'string' || root.length === 0) continue;
    let realRoot = path.resolve(root);
    try {
      realRoot = await canonicalRealPath(realRoot);
    } catch {
      // 保持原路径
    }
    if (isInsideRealPath(realRoot, real)) return true;
  }
  return false;
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
 * 决定每个插件包要恢复到哪个目录。
 *
 * **只认可信来源**：`trustedDependencies` —— 它由调用方（index.js）在写入任何
 * 远端配置**之前**从本地 profile 的 `package.json` 收集，远端的 `_plugins.json`
 * 和远端的 `package.json` 都不参与路径决策。这样即使 WebDAV 账号泄漏、远端快照
 * 被篡改，也无法通过改写 `package.json` 把插件文件写到目标根之外。
 *
 * 本地没有声明的依赖一律回退到 `<profile>/plugins/<包名>` 并改写依赖。
 *
 * @param {string} profileDir profile 目录。
 * @param {string[]} packageNames 快照里出现的包名。
 * @param {Array<{ name: string, originalDir: string }>} pluginList 远端 `_plugins.json`。
 * @param {Map<string, string> | Record<string, string> | undefined} trustedDependencies
 *   本地 profile 在写入远端配置前声明的本地插件目录。
 * @param {string} dshHome DSH 主目录。
 * @param {string[]} warnings 警告收集器。
 * @returns {Promise<Map<string, { dir: string, fallback: boolean, originalDir: string }>>}
 */
async function resolvePluginTargets(profileDir, packageNames, pluginList, trustedDependencies, dshHome, warnings) {
  const declared = new Map(pluginList.map((item) => [item?.name, item]));
  const trusted =
    trustedDependencies instanceof Map
      ? trustedDependencies
      : new Map(Object.entries(trustedDependencies ?? {}));
  const targets = new Map();
  for (const name of packageNames) {
    const hint = declared.get(name);
    if (hint === undefined) {
      warnings.push(`跳过未在 _plugins.json 声明的插件包: ${name}`);
      continue;
    }
    const fallbackDir = path.join(profileDir, FALLBACK_PLUGIN_DIR, name);
    let targetDir;
    const trustedDir = trusted.get(name);
    if (typeof trustedDir === 'string' && trustedDir.length > 0) {
      if ((await isDirectory(trustedDir)) && !(await isForbiddenPluginRoot(trustedDir, dshHome))) {
        targetDir = path.resolve(trustedDir);
      } else {
        warnings.push(`插件 ${name} 的原目录不可用或位于受保护目录，改为恢复到 profile 内: ${trustedDir}`);
      }
    } else {
      warnings.push(`插件 ${name} 不在本地 profile 的依赖声明里，恢复到 profile 内: ${name}`);
    }
    if (targetDir === undefined) {
      targetDir = fallbackDir;
    }
    targets.set(name, {
      dir: targetDir,
      fallback: targetDir === fallbackDir,
      originalDir: typeof hint.originalDir === 'string' ? hint.originalDir : '',
    });
  }
  return targets;
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
  if (manifest.dependencies === null || typeof manifest.dependencies !== 'object') {
    manifest.dependencies = {};
  }
  const nextSpec = `link:${relativeSpec}`;
  if (manifest.dependencies[name] === nextSpec) return false;
  manifest.dependencies[name] = nextSpec;
  await prepareWriteTarget(profileDir, file);
  await writeFileAtomic(file, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  return true;
}

/**
 * 应用一份远端快照。
 *
 * @param {object} input
 * @param {Array<{ name: string, bytes: Uint8Array }>} input.configEntries config.zip 条目。
 * @param {Array<{ name: string, bytes: Uint8Array }>} input.pluginEntries plugins.zip 条目。
 * @param {Array<{ name: string, originalDir: string }>} input.pluginList `_plugins.json` 的内容。
 * @param {Map<string, string> | Record<string, string> | undefined} [input.trustedDependencies]
 *   下载**之前**从本地 profile `package.json` 读取的本地插件目录（唯一可信的插件目标来源）。
 * @param {string} input.profileDir 当前 profile 目录。
 * @param {string} input.dshHome DSH 主目录。
 * @param {string} input.backupsRoot 备份根目录。
 * @param {number} input.backupKeep 备份保留份数。
 * @param {boolean} [input.allowCredentials] 是否允许恢复 `home/.credentials.yaml`。
 * @returns {Promise<{ backupDir: string, backedUp: number, written: number, plugins: Array<object>, warnings: string[] }>}
 */
export async function applySnapshot(input) {
  const { profileDir, dshHome, backupsRoot, backupKeep } = input;
  const allowCredentials = input.allowCredentials !== false;
  const configEntries = Array.isArray(input.configEntries) ? input.configEntries : [];
  const pluginEntries = Array.isArray(input.pluginEntries) ? input.pluginEntries : [];
  const pluginList = Array.isArray(input.pluginList) ? input.pluginList : [];

  const warnings = [];
  const stamp = backupStamp();
  const backupDir = path.join(backupsRoot, stamp);

  // ── 1. 配置条目：白名单 + 字符串级路径校验 ──
  const configTargets = [];
  for (const entry of configEntries) {
    let name;
    try {
      name = normalizeRelativeZipPath(entry.name);
    } catch (error) {
      warnings.push(`忽略非法 zip 条目名: ${entry.name}（${error?.message ?? error}）`);
      continue;
    }
    const [scope, ...rest] = name.split('/');
    if (scope !== 'profile' && scope !== 'home') {
      warnings.push(`忽略未知作用域的配置条目: ${entry.name}`);
      continue;
    }
    const file = rest.join('/');
    const allowed = scope === 'profile' ? ALLOWED_PROFILE_FILES : ALLOWED_HOME_FILES;
    if (rest.length !== 1 || !allowed.has(file)) {
      warnings.push(`忽略未授权的配置条目: ${entry.name}`);
      continue;
    }
    // 本机关闭了凭据同步时，不接受远端把 .credentials.yaml 写回来。
    if (scope === 'home' && file === CREDENTIALS_FILE_NAME && allowCredentials === false) {
      warnings.push('本机已关闭凭据同步（syncCredentials=false），忽略 home/.credentials.yaml');
      continue;
    }
    const root = scope === 'profile' ? profileDir : dshHome;
    configTargets.push({ entry, target: resolveInsideRoot(root, file), backupPath: name, root });
  }

  // ── 2. 插件条目：按包名归组 ──
  const packageNames = [];
  const pluginTargets = [];
  for (const entry of pluginEntries) {
    let name;
    try {
      name = normalizeRelativeZipPath(entry.name);
    } catch (error) {
      warnings.push(`忽略非法插件文件名: ${entry.name}（${error?.message ?? error}）`);
      continue;
    }
    if (name === '_plugins.json') continue;
    const [packageName, ...rest] = name.split('/');
    if (rest.length === 0) {
      warnings.push(`忽略插件包顶层条目: ${entry.name}`);
      continue;
    }
    if (!packageNames.includes(packageName)) packageNames.push(packageName);
    pluginTargets.push({ entry, packageName, relative: rest.join('/') });
  }

  // 先把配置写进 profile，再据此决定插件目标（依赖声明可能来自远端快照）。
  // 注意：备份与写入都要在目标根内完成，所以先拿备份目录。
  const backupTargets = [];
  for (const item of configTargets) {
    backupTargets.push({ target: item.target, backupPath: item.backupPath });
  }

  const { backedUp } = await backupExistingFiles(backupTargets, backupDir);

  let written = 0;
  const failed = [];
  for (const item of configTargets) {
    try {
      await prepareWriteTarget(item.root, item.target);
      await writeFileAtomic(item.target, item.entry.bytes);
      written += 1;
    } catch (error) {
      if (error instanceof ApplyError) throw error; // 路径逃逸是致命错误
      failed.push(`${item.backupPath}: ${error?.message ?? error}`);
    }
  }

  // ── 3. 插件目标：只信「下载前」本地 profile 的依赖声明（远端快照无法操控） ──
  const packageTargets = await resolvePluginTargets(
    profileDir,
    packageNames,
    pluginList,
    input.trustedDependencies,
    dshHome,
    warnings,
  );

  // 插件文件的备份（目标确定之后才能算）
  const pluginBackupTargets = [];
  for (const item of pluginTargets) {
    const target = packageTargets.get(item.packageName);
    if (target === undefined) continue;
    resolveInsideRoot(target.dir, item.relative); // 字符串校验，逃逸即抛
    pluginBackupTargets.push({
      target: path.join(target.dir, ...item.relative.split('/')),
      backupPath: `plugins/${item.packageName}/${item.relative}`,
    });
  }
  const pluginBackup = await backupExistingFiles(pluginBackupTargets, backupDir);

  for (const item of pluginTargets) {
    const target = packageTargets.get(item.packageName);
    if (target === undefined) continue;
    try {
      const resolved = resolveInsideRoot(target.dir, item.relative);
      await prepareWriteTarget(target.dir, resolved);
      await writeFileAtomic(resolved, item.entry.bytes);
      written += 1;
    } catch (error) {
      if (error instanceof ApplyError) throw error;
      failed.push(`plugins/${item.packageName}/${item.relative}: ${error?.message ?? error}`);
    }
  }

  // ── 4. 回退到 profile 内目录的插件：改写依赖为相对 link ──
  const pluginSummary = [];
  for (const [packageName, target] of packageTargets) {
    const relativeSpec = `./${FALLBACK_PLUGIN_DIR}/${packageName}`;
    if (target.fallback) {
      const rewritten = await rewriteLocalDependency(profileDir, packageName, relativeSpec).catch((error) => {
        warnings.push(`改写 profile 依赖失败（${packageName}）: ${error?.message ?? error}`);
        return false;
      });
      if (rewritten) {
        warnings.push(`插件 ${packageName} 已改写到 ${relativeSpec}，需要重启 DSH 并重新安装依赖后才生效`);
      }
    }
    pluginSummary.push({
      name: packageName,
      dir: target.dir,
      fallback: target.fallback,
      originalDir: target.originalDir,
    });
  }

  // ── 5. 清理过期备份 ──
  await pruneBackups(backupsRoot, backupKeep).catch(() => 0);

  if (failed.length > 0) {
    warnings.push(`有 ${failed.length} 个文件写入失败（已跳过）: ${failed.join('；')}`);
  }

  return {
    backupDir,
    backedUp: backedUp + pluginBackup.backedUp,
    written,
    plugins: pluginSummary,
    warnings,
    failed,
  };
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
