# 版本历史

本插件的版本号同时出现在 `package.json` 与 `index.js` 的 `PLUGIN_VERSION`（测试会断言两者一致），
设置页「状态」里显示的版本号来自后者。

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
