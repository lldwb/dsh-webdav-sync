# dsh-webdav-sync

> 通过 WebDAV 在多台设备之间同步 **DeepSeek Harness（DSH）的配置与插件**，**不同步会话**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

`dsh-webdav-sync` 是 DSH 的一个插件（bundle + Host 插件 + 设置页），把当前 profile 的配置文件和本地插件包打包成快照上传到 WebDAV，或从 WebDAV 下载快照恢复。同步协议参考 [CC Switch](https://github.com/farion1231/cc-switch) 的 WebDAV 云同步机制：远端只放 `manifest.json` + `config.zip` + `plugins.zip`，manifest 记录每个 artifact 的 SHA-256 与整体快照 id；上传时 artifact 先传、manifest 最后传，下载时先校验再落盘。

## 功能

- **配置与插件一起同步**：profile 的 `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-lock.yaml`，以及所有 `link:` 本地插件包的源码目录。
- **不同步会话**：`sessions/`、`attachments/`、`cache/`、日志、`.anonymous-user-id` 等一律不碰。
- **WebDAV 服务商预设**：坚果云（Jianguo Cloud / Nutstore）、Nextcloud、群晖（Synology）与自定义地址。
- **手动上传 / 下载**：设置页一键「上传到云端」「从云端下载」，下载前自动备份本地将被覆盖的文件。
- **自动同步**：开启后，profile 配置或 home 配置文件变化约 1.5 秒后自动上传（同一内容不会重复上传）。
- **多套配置**：「同步配置名」用于在同一 WebDAV 上并存多套快照（例如 `default`、`work`）。
- **密码不进配置文件**：WebDAV 密码保存在 DSH 凭据库（凭据引用 `DSH_WEBDAV_SYNC_PASSWORD`），不写进 `cordis.patch.yml`。

## 安装

插件目录需要能被 DSH profile 解析。任选一种：

**方式一：`plugin_manager` 安装本地目录**（推荐，DSH 会处理 link 与 profile 清单）

```text
plugin_manager install_bundle <本仓库目录的绝对路径>
```

**方式二：手动 link**

1. 在 profile 的 `package.json` 的 `dependencies` 里加 `"dsh-webdav-sync": "link:<本仓库绝对路径>"`，并把 `dsh-webdav-sync` 加进 `dsh.profile.bundles`；
2. 在 profile 目录运行一次 `pnpm install`；
3. 重启 DSH。

本插件有一个运行时依赖 `@deepseek-ai/schemastery`（声明 `Config` schema 用），**装上插件后需要在插件目录执行一次依赖安装**：

```bash
npm install     # 或 pnpm install
```

装好后打开「设置 → 插件」，应能看到「WebDAV 云同步」卡片。

## 配置

1. **同步方式**：目前只有 WebDAV。
2. **服务商**：选择坚果云会自动填入 `https://dav.jianguoyun.com/dav/`；Nextcloud / 群晖会填占位模板，改成自己的地址即可；自定义则完全手填。
3. **WebDAV 服务器地址**：必须指向可写的 WebDAV 目录。
4. **WebDAV 账户 / 密码**：
   - 坚果云请在网页端「账户信息 → 安全选项 → 第三方应用管理」生成**第三方应用密码**，**不要填登录密码**。
   - 密码保存在 DSH 凭据库中；输入后点表单的「保存」即写入。
5. **远程根目录**：默认 `dsh-sync`；可写多级（如 `backup/dsh`）。
6. **同步配置名**：默认 `default`，不同名字对应远端不同目录。
7. **自动同步**：默认开启。
8. 依次点「测试连接」→「上传到云端」。换设备时点「从云端下载」，**重启 DSH 后生效**。

## 同步了什么

| 内容 | 是否同步 | 说明 |
| --- | --- | --- |
| `$DSH_HOME/profiles/<profile>/package.json` | ✅ | 插件依赖与 bundle 清单 |
| `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | ✅ | 用户补丁层（模型、插件配置等） |
| `$DSH_HOME/profiles/<profile>/cordis.yml` | ✅ | profile 根配置 |
| `$DSH_HOME/profiles/<profile>/pnpm-lock.yaml`、`pnpm-workspace.yaml` | ✅ | 依赖锁定 |
| `$DSH_HOME/.credentials.yaml` | ✅（默认，可关） | **含 API 密钥等凭据**，见「安全」 |
| `$DSH_HOME/settings.yaml`、`settings.json` | ✅（存在才同步） | 全局设置 |
| profile 里 `link:` / `file:` 的本地插件包 | ✅ | 源码目录（排除 `node_modules/`、`.git/`、`.scratch/`、`*.log`） |
| `sessions/`、`attachments/`、`cache/`、`logs/` | ❌ | 会话与缓存，不同步 |
| `.plugin-manager/`、`node_modules/`、`dsh-runtimes/`、`storages/`、`.anonymous-user-id` | ❌ | 本机运行时/安装产物/设备身份 |
| registry 安装的插件源码 | ❌ | 只同步 profile 清单与 lockfile，重装即可 |

## 工作原理

远端目录（`{服务器地址}/{远程根目录}/v1/{同步配置名}/`）：

```text
manifest.json     # 最后上传；记录 artifact 的 sha256/大小与 snapshotId
config.zip        # 配置快照（profile/... 与 home/... 两个前缀）
plugins.zip       # 插件包快照（<包名>/... + _plugins.json 记录原路径）
```

- **快照 id**：`sha256("config.zip:<sha>|plugins.zip:<sha>")`。zip 打包是确定性的（固定条目时间、排序），所以同样的内容在任何机器上重建都会得到同一个 id —— 自动同步靠它判断「本地是否真的变了」。
- **上传顺序**：`config.zip` → `plugins.zip` → `manifest.json`。下载方只认 manifest，所以不会读到半新半旧的状态。
- **下载流程**：读 manifest → 校验协议版本 → 下载两个 zip → 逐个校验大小与 SHA-256 → 解包 → 备份将被覆盖的本地文件到 `$DSH_HOME/webdav-sync/backups/<时间戳>/` → 原子写入 → 记录状态。
- **插件恢复位置**：优先写回快照里记录的原路径；原路径不可用（换机器/盘符不存在）时写到 `<profile>/plugins/<包名>`，并把 profile `package.json` 的依赖改写为 `link:./plugins/<包名>`（此时需要重启 DSH 并重新安装依赖）。
- **状态文件**：`$DSH_HOME/webdav-sync/state.json`（上次同步时间、成功动作、错误、快照 id）。

## 安全须知

- 默认会把 `.credentials.yaml` 一起同步（否则换机后所有 API 密钥都要重填）。它包含**明文凭据**，WebDAV 服务端可以看到。如果你的 WebDAV 服务不可信，请在 `cordis.patch.yml` 里把 `syncCredentials` 设为 `false`。
- WebDAV 密码存在 DSH 凭据库（`.credentials.yaml`）中，**不会**写进 profile 的 `cordis.patch.yml`，也不会出现在日志里。注意它仍会随 `syncCredentials` 被同步到云端（这是「配置」的一部分）。
- 下载会覆盖本地配置；下载前会自动备份，备份目录见上。**重启 DSH 后生效。**
- **下载端有路径防护**：
  - 只允许恢复白名单内的配置文件（profile 的 5 个配置文件，home 的 `.credentials.yaml` / `settings.yaml` / `settings.json`）；zip 里其它路径（`sessions/`、`node_modules/` 等）一律忽略并记 warning。
  - 目标父目录用 `realpath` 做二次校验，Windows junction / symlink 无法把写入引出目标根。
  - 插件包写回位置**只信「下载前」本地 profile 的依赖声明**（`link:` / `file:`），远端快照里的 `package.json` 与 `_plugins.json` 都不能决定写入位置；系统目录与用户敏感目录（桌面/文档/下载/启动项等）一律拒绝，无法写回时回退到 `<profile>/plugins/<包名>` 并改写依赖。
  - 拒绝含 `:`（ADS）、以 `.`/空格结尾、以及 Windows 保留设备名（`CON`/`NUL` 等）的 zip 条目名。
  - 本机 `syncCredentials: false` 时，下载会忽略远端快照里的 `.credentials.yaml`，不会覆盖本地凭据。
- 上传前会先读远端 `manifest.json`：协议版本不兼容时**拒绝覆盖**并给出提示。
- 建议使用 WebDAV 的专用应用密码（坚果云等），不要使用主账号密码。

## 限制与已知问题

- **下载后需要重启 DSH 才生效**：插件配置在启动时读取，运行中的进程不会重读被覆盖的配置文件。
- **自动同步只上传、不自动下载**：多台设备同时改配置时以「最后上传者」为准，不会合并。要拉取另一台设备的改动，请手动点「从云端下载」。
- **只监听 profile 与 home 配置的变化**：`link:` 插件包的源码目录可能在本机其他位置，且 Windows 的 `fs.watch` 不跟随 junction / 符号链接，这类改动不会即时触发自动同步，最多等 60 秒兜底轮询，或手动点「上传到云端」。
- **跨机器恢复插件包**：若原插件目录不存在（换机器/换盘符），插件会回退到 `<profile>/plugins/<包名>`，依赖改写成 `link:./plugins/<包名>`。此时**还要在目标机器上装一次依赖**，否则插件管理器会显示「包不可用 / cannot resolve profile bundle」：

  ```powershell
  # 1) 建立 profile 的依赖链接（DSH 自带 pnpm，无需另装）
  & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop install

  # 2) 给每个恢复到 profile 内的插件装它自己的依赖（例如 dsh-web-search-opencode-ds 需要 schemastery）
  Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\plugins" -Directory | ForEach-Object {
    Push-Location $_.FullName; npm install; Pop-Location
  }
  ```

  然后重启 DSH。下载结果里也会显示第一条命令（`requiresInstall` / `installHint`），设置页会把它直接写在成功提示里。
- **同一时刻只允许一个同步动作**（上传/下载/测试/自动同步互斥）。
- **解压上限独立于下载上限**：zip 解压有固定的单条目/总量上限（防压缩炸弹），调大 `maxArtifactBytes` 不会放大解压上限。
- 远端协议版本不匹配（例如未来升级）时会明确报错，不会覆盖。
- 坚果云等部分服务对顶层目录删除有限制；本插件不会删除远端目录，只覆盖三个文件。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 提示「没有找到 WebDAV 密码」 | 设置页密码框输入后点「保存」写进凭据库；或设置环境变量 `DSH_WEBDAV_SYNC_PASSWORD` |
| 401 / 403 | 坚果云请用「第三方应用密码」；确认地址在 `/dav/` 下且可写 |
| MKCOL 409 / 顶层目录创建失败 | 在 WebDAV 网页端手动创建「远程根目录」后重试 |
| 下载后界面没变化 | 重启 DSH |
| 插件列表里出现「异常 / 包不可用」（跨机恢复后） | 见上面「跨机器恢复插件包」：先在目标机器跑 `dsh plugin --profile desktop install`，再给 `<profile>/plugins/*` 里的插件各跑一次 `npm install`，然后重启 |
| 想回滚一次下载 | 把 `$DSH_HOME/webdav-sync/backups/<时间戳>/` 里的文件复制回去 |
| 配置文件写坏了 | 同上，或从备份目录恢复后重启 |

## 开发

```bash
# 单元测试 + 端到端测试（本地 mock WebDAV，不联网）
node --test

# 语法检查
node --check index.js
node --check client.js
```

目录结构：

```text
dsh-webdav-sync/
├── index.js            # Host 半：Config、同步编排、RPC 通道、自动同步
├── client.js           # 浏览器半：设置页（手写 ModuleLoader bundle）
├── lib/
│   ├── zip.mjs         # 确定性 ZIP 读写（store/deflate，CRC32，UTF-8 文件名）
│   ├── webdav.mjs      # fetch 实现的 WebDAV 客户端（PROPFIND/MKCOL/PUT/GET/HEAD）
│   ├── snapshot.mjs    # manifest、sha256、snapshotId、zip 打包
│   └── apply.mjs       # 把快照写回本地（备份、路径遍历防护、原子写）
├── cordis.patch.yml    # Loader 补丁：插入本插件的行
├── locale/{zh,en}.json # 插件卡片标题/描述
└── test/               # node --test 用例
```

## License

[MIT](./LICENSE)

参考项目：[cc-switch](https://github.com/farion1231/cc-switch)（WebDAV 同步协议与设置页交互的灵感来源）。
