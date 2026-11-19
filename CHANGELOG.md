# 版本历史

本插件的版本号同时出现在 `package.json` 与 `index.js` 的 `PLUGIN_VERSION`（测试会断言两者一致），
设置页「状态」里显示的版本号来自后者。

## 0.2.7

**适配 DSH 0.2.2-rc.5：删除 RPC 路由上的 master-only `auth` 键，准入由 handler 内 `connection.admit` 保证。**

- **变更**：`webServer.register()` 的 `/dsh-webdav-sync` prefix 路由对象删掉 `auth: 'required'`。
  该键只存在于 master 基线：`dsh-v0.2.2-rc.5` 的 `WebRoute` 只有 `kind` / `path` / `handler`
  （`packages/host/webserver/src/index.ts`），`register()` 只做 kind/path 去重后
  `table.set(path, route)`，没有路由级准入逻辑，多出的 `auth` 键被静默忽略、不产生任何认证
  效果。留着它会让人误以为「路由级认证」存在，故本次删除；这是纯清理，**行为不变**。
- **准入不变**：handler 内继续用 `connection.admit(req)`，**这是 rc.5 上唯一的准入**。
  rc.5 的 `admit(request: ConnectionTrustRequest): PeerAdmission`，
  `PeerAdmission` 只有 `{ peer }` 或 `{ rejection: 401 | 403 }`（没有 503）；
  本插件在 `'rejection' in admission` 时按该值写 401/403。**`admit` 未删、也不能删。**
- **验证**：
  - `git show dsh-v0.2.2-rc.5:packages/host/webserver/src/index.ts` → `WebRoute` 只有
    `kind` / `path` / `handler`；
  - `git grep "auth:" dsh-v0.2.2-rc.5 -- packages/host/webserver` → 零命中；
  - 单测 `node --test` **82/82**。测试无需改：没有任何用例断言路由 `auth` 字段
    （`test/webdav.test.mjs` 里的 `auth` 是 WebDAV Basic Auth、`503` 是 WebDAV 服务端
    错误码语义，与路由准入无关）。

## 0.2.6

**适配 DSH 0.2.2-rc.3：RPC 路由显式声明 `auth: 'required'`，向后兼容 rc.2。**

- **变更**：设置页的 `/dsh-webdav-sync` prefix 路由在 `webServer.register()` 里显式声明
  `auth: 'required'`。目标版本 WebServer 新增 `auth: 'anonymous' | 'required' | 'deny'`
  （默认 `required`，`packages/host/webserver/src/index.ts` 的 `authPolicy()`），官方
  `client-connection` 的 `/api` 路由也显式写 `'required'`。本插件的路由只给**已登录的
  设置页**用，语义就是 required；显式写出来让「必须认证」成为注册契约的一部分，不再
  依赖默认值（默认值一旦变化，缺省写法会让这条通道静默失去认证）。
- **认证语义不变**：handler 内继续用 `connection.admit(req)`。这不是冗余——rc.2 的
  WebServer **完全不做路由准入**（rc.2 `lib/index.js` 的 `handle()` 直接
  `responder.handler(req, res)`，没有 authorize 步骤），所以 `admit()` 是 rc.2 上唯一的
  认证。目标版本两者都在（WebServer 先准入 + handler 再 admit，`admit()` 仍在且
  `PeerAdmission` 形状不变），保留它是双保险。
- **向后兼容 rc.2**：rc.2 的 `register(route)` 只做 `(kind, path)` 去重后 `table.set()`，
  多出的 `auth` 键被静默忽略（已从本机 `app.asar` 里 rc.2 的
  `@deepseek-ai/dsh-host-webserver/lib/index.js` 核实），因此可无条件写。
- **核对无其它破坏点**：`configForms.get/whileServed`、`plugins.item` 槽位、
  `ctx.remote.credentials.describe/set`（`describe([ref])` → `value[ref].{configured,writable}`）、
  `ctx.connection.rpc.call`、`credentials.resolve`、`settings.configure({auto:false}, fiber)`、
  `profileContext` 在目标版本均未变；未使用 `ctx.root`、`Service.config`、`rankByName`、
  删除的包子路径等 0.2.2-rc.3 破坏点。
- 单测 `node --test` **82/82**。

## 0.2.5

**适配 DSH 0.2.2-rc.2：真实 Loader + 设置页 UI 回归通过，无代码改动。**

- **核对**：`configForms.get()` / `configForms.whileServed()`、`plugins.item`、
  `plugins.bundle.config` 槽位、`ctx.remote.credentials.describe/set`、自建 prefix 路由
  （`ctx.webServer.register` + `connection.admit`）在 rc.2 均未变；rc.2 对
  `plugins.tab` 只新增可选 `update` 能力（加法）。
- **回归**：devkit web 沙箱 `b-webdav-sync`（真实 Chrome + 真实 Loader）：client 半进页面
  清单、打开时控制台 0 错误；侧边栏「插件」页出现「WebDAV 云同步」卡片；点开详情页后
  标题/描述/图标、同步方式、服务商、服务器地址、账户、密码（`type=password`，「未配置」）、
  远程根目录、同步配置名、两个开关、状态区（来自 RPC）与四个动作按钮全部渲染。
- **仓库卫生**：删除本地工具（pnpm）生成的杂散 `pnpm-lock.yaml`（本仓库锁文件是
  `package-lock.json`），并在 `.gitignore` 里忽略它，避免以后误提交。
- 单测 `node --test` **81/81**。

## 0.2.4

**变更**

- **图标按官方矢量语言重绘**：36×36 青绿渐变云 + 上下一对 periwinkle（`#658EFF`）箭头，
  表达「云端与本地双向同步」；配色只用官方 artwork 调色板。
- **「内置插件配置」卡片插画**：client 半新增 `ITEM_ARTWORK_ID` / `ITEM_ARTWORK_URI` /
  `registerItemArtwork()`，在 `apply()` 里把 `icon.svg` 的 data URI 登记进
  `globalThis.__DSH_PLUGIN_ITEM_ARTWORK__['webdav-sync']`；新增 `test/client-artwork.test.mjs`
  断言常量与 `icon.svg` 逐字节一致。
- `node --test` → 81/81 通过。

## 0.2.3

**变更**

- 适配 **DSH 0.2.2-rc.1**。**无代码改动**——用到的 Host / Client 契约在 0.2.2 未发生破坏性变化，
  本次只补回归证据与版本记录。`node --test` → 75/75 通过。
- 回归证据：devkit web 沙箱（`ui-webdav`）合成树含 `- id: webdav-sync`；client 半进入页面清单；
  设置页完整渲染（服务商 / 地址 / 账户 / 密码密文字段「未配置」/ 远程根目录 / 同步配置名 / 两个开关 /
  状态区），状态区数据来自 RPC，证明通道可达；控制台 **0 错误**。沙箱未配置 WebDAV 密码，故未做真实上传/下载。

## 0.2.2

**变更**

- 插件图标改为手绘 SVG（`icon.svg`，替换上一轮的 PNG 位图），对齐 dsh 官方插件图标的矢量语言（36×36、透明底、官方蓝色渐变、同一描边与留白）。

## 0.2.1

**变更**

- 插件图标换成 gpt-image-2.5 生成的 PNG 图标（256×256，圆角透明）。

## 0.2.0

首个可日常使用的版本，包含从 0.1.0 起在多设备真实使用中修掉的一批问题。

**修复**

- **设置页动作全部 405**：改用自建 prefix 路由 + Connection 的 `admit()` 认证，绕开
  `connection.rpc.handle` 对调用方 ctx 同时 inject `webServer` 的隐式要求（`/api` 正常但自定义
  通道 405 就是这个特征）。
- **选了「服务商」却报「尚未配置 WebDAV 服务器地址」**：服务商下拉只在手动切换时写入地址，
  重启后恢复的表单地址栏是空的。现在 Host 侧按预设兜底（坚果云 → `https://dav.jianguoyun.com/dav/`），
  设置页恢复表单时也会自动补地址。
- **未配置时自动同步往状态里写错误**：配置不完整（缺地址/账户/密码）时静默跳过，不再报错。
- 下载后重建本地快照，跨机恢复不会让自动同步把本机适配版误传回远端。

**新增**

- **跨机恢复自动装依赖**：插件原目录不存在时回退到 `<profile>/plugins/<包名>`，并自动用 DSH 自带的
  node + pnpm 跑 profile 与插件自身的依赖安装（实测约 1 秒）；失败才提示手动命令。
- **自动同步不再覆盖其它设备的新上传**：上传前比对远端 `snapshotId` 与本地记录的
  `lastRemoteSnapshotId`（CC Switch 的 `lastRemoteHash` 语义）。自动同步发现远端更新过就跳过，
  记 `REMOTE_AHEAD` 并在设置页显示「远端有更新的上传，来自 <设备>」；手动上传仍覆盖，但会报告
  覆盖了谁的版本。
- 下载结果返回 `requiresInstall` / `installHint`，设置页直接显示要跑的依赖安装命令（失败时）。

**安全**

- 插件恢复目标只信「下载前」本地 `package.json` 的依赖声明（远端 `package.json` / `_plugins.json`
  都是远端可控数据）；配置文件与 home 文件走白名单；拒绝 Windows 怪物文件名与系统目录；
  上传前读远端 manifest 失败时 fail-closed，不覆盖。

## 0.1.0

初始版本：CC Switch 风格的远端布局（`<baseUrl>/<remoteRoot>/v1/<syncProfile>/`，
`manifest.json` + `config.zip` + `plugins.zip`）、确定性 ZIP 与 snapshotId、设置页（服务商预设 /
地址 / 账户 / 密码走凭据域 / 远程根目录 / 同步配置名 / 自动同步 / 同步凭据文件）、
测试连接 / 上传 / 下载 / 状态轮询、自动同步（防抖 1.5 秒、上限 10 秒、60 秒兜底轮询）、
下载前备份与状态记录。
