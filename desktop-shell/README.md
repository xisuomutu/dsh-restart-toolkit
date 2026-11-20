# 桌面壳补丁说明

> 文档状态：已发布  
> 适用范围：DSH Desktop 0.2.2-rc.5（Windows）  
> 工具包版本：1.0.0  
> 相关文档：[架构设计](../docs/01-architecture.md) · [进程生命周期](../docs/02-process-lifecycle.md) · [测试计划](../docs/03-test-plan.md)

## 1. 目的与范围

本目录实现 DSH Restart Toolkit 的桌面壳部分：在原生托盘菜单中新增
“重启 DeepSeek Harness”，并完成完整退出、同路径/同参数重启、watchdog 观测和失败处理。

本目录不负责安装 DSH；安装步骤见 [../INSTALL.md](../INSTALL.md)。

## 2. 设计概览

托盘由 Electron 桌面壳的 `DesktopTray` 创建，Cordis 插件运行在 Host 子进程，二者之间没有
托盘扩展点。因此实现分为三层：

| 层 | 实现 | 职责 |
|---|---|---|
| 桌面壳补丁 | `patch/main.js.patch` / `src/tray-restart.js` | 菜单项、`restartFromTray()`、受控 IPC、启动重试、Host 日志 |
| watchdog | `runtime/tray-restart-watchdog.cjs` | 壳退出后观测进程、超时清理、回执、错误提示 |
| 可选 bundle | `../plugin/dsh-restart-command` | `/restart-dsh` 通过 `restart-app` IPC 复用同一路径 |

补丁**不**修改现有 Open/Quit 的点击逻辑、托盘图标、工具提示、其它菜单、profile 或插件 Loader。

## 3. 补丁点

`patch/main.js.patch` 对 `resources/app.asar/lib/main.js` 做 13 处精确修改：

| # | 位置 | 修改 |
|---|---|---|
| 1 | `lib/types/tray.js` | 新增 `trayMenuTemplate(messages, actions)`；Open/Quit 完全保留，Restart 插在两者之间；标签为 `messages.restartApplication + " DeepSeek Harness"` |
| 2 | `DesktopTray.relabel()` | 用模板构建菜单，并调用新增的 `restart` 回调 |
| 3 | `main()`（`let quitting` 之后） | 新增 `restartFromTray()`：单飞、快照、拉起 watchdog、`app.relaunch()`、`quitWithoutConfirmation()`、失败弹框 |
| 4 | `new DesktopTray({...})` | 注入 `restart: () => restartFromTray()` |
| 5 | `isDesktopHostEvent()` | 接受 Host 的 `restart-app` 消息（仅整数 `requestId`） |
| 6 | `DesktopHostProcess` 字段 | 增加 `onRestartRequest` |
| 7 | 构造器 / JSDoc | 增加 `onRestartRequest` 参数 |
| 8 | 构造器赋值 | 保存 `onRestartRequest` |
| 9 | Host 消息处理 | 收到 `restart-app` 时调用 `onRestartRequest` |
| 10 | Host 创建处 | 注入 `DSH_DESKTOP_RESTART_IPC=1`，并传入 `() => restartFromTray()` |
| 11 | Host stderr 处理 | 追加写入 `tray-restart/host-stderr.log` |
| 12 | `openInitialWindow()` | 新增 `readWelcomeStateWithRetry()`：对 `ECONNRESET` / `fetch failed` 等瞬时错误重试 |
| 13 | Host `close` 处理 | 追加写入 `tray-restart/host-events.log`（退出码 + stderr 尾部） |

每个锚点在原始 `main.js` 中必须恰好出现一次；`build-patch.mjs` 在锚点缺失或重复时失败，
避免部分应用。

### 3.1 启动加固（v2）

v2 增加：

- `readWelcomeStateWithRetry()`：最大 3 次尝试，间隔 300/600ms；
- Host stderr 与 close 事件落盘；
- 重试记录写入 `tray-restart/startup.log`。

这些修改不改退出链、认证协议、Host 启动参数或插件 Loader。v3 仅调整托盘文案，保留 v2 加固。

## 4. 文件布局

```text
runtime/tray-restart-watchdog.cjs   复制到 <DSH_INSTALL>\resources\
src/tray-restart.js                 源码集成用的可测试模块
patch/main.js.patch                 针对 0.2.2-rc.5 的补丁
patch/build-patch.mjs               严格锚点替换，生成 main.patched.js
patch/check-patch.mjs               只读校验锚点/语法
patch/check-compat.mjs              只读检查版本/ASAR/fuse/锚点
patch/repack-asar.mjs               生成 app.patched.asar（附加式，不改原包）
patch/apply-patched-asar.ps1        预检 / 应用 / 回滚（默认 dry-run）
patch/apply-after-exit.ps1          等待 DSH 退出 → 应用 → 重启
test/*.test.mjs                     单元与 watchdog 集成测试
```

## 5. 源码集成（推荐）

适用于可获取/构建桌面壳源码的场景：

1. 将 `src/tray-restart.js` 集成到桌面壳源码，导入 `createTrayRestart` 与 `trayMenuTemplate`；
2. 创建 `DesktopTray` 时传入 `restart` 回调；`relabel()` 使用 `trayMenuTemplate`；
3. 在 `DesktopHostProcess` 中增加 `restart-app` 处理，并向 Host 环境注入
   `DSH_DESKTOP_RESTART_IPC=1`；
4. 构建时把 `runtime/tray-restart-watchdog.cjs` 作为 extraResource 复制到 `resources/`；
5. 运行 `desktop-shell/test/*.test.mjs`，按 [测试计划](../docs/03-test-plan.md) 验收。

源码集成不需要改 `app.asar`，不会被 ASAR integrity 拒绝；升级时重新构建即可。

## 6. 已安装应用补丁（可回滚部署）

> **风险**：修改 `resources/app.asar` 不是官方支持的方式；会受签名/完整性/企业策略影响；
> 桌面壳更新会覆盖。建议先在测试副本或可回滚安装上验证。

### 6.1 附加式 ASAR 补丁

`repack-asar.mjs` 不重新打包整个 209 MB 归档：

1. 复制原始 `app.asar`；
2. 只改 JSON 头中 `lib/main.js` 一项（`offset` 指向末尾、`size` 更新、删除该条目的 `integrity`）；
3. 新 `main.js` 追加到文件末尾；
4. 其余 21,721 个文件的 offset 和字节保持不变；头部 JSON 槽位等长填充；
5. 报告包含输入/输出 SHA-256、新旧 `main.js` 哈希与 offset。

输出是新文件，不覆盖输入包。部署脚本会校验“报告输入哈希 == 当前安装 `app.asar`”，
防止用旧版本补丁覆盖新版本。

### 6.2 应用步骤

**推荐：等待退出并自动应用**

从 DSH 之外的 PowerShell 运行；保持 DSH 打开，按提示退出：

```powershell
powershell -File desktop-shell\patch\apply-after-exit.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json"
```

脚本先 dry-run，等待所有 `DeepSeek Harness.exe` 退出（默认 300s），应用补丁并重新启动。

**手动分步**

```powershell
# 1) 生成补丁副本（不改安装）
node desktop-shell\patch\repack-asar.mjs `
  "<DSH_INSTALL>\resources\app.asar" `
  "$env:TEMP\app.patched.asar" `
  --report "$env:TEMP\report.json"

# 2) 预检：校验来源哈希、列出备份路径；不改文件
powershell -File desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json"

# 3) 完全退出 DSH 后应用
powershell -File desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json" `
  -Apply
```

应用脚本：

- 检测 `DeepSeek Harness.exe` 是否仍在运行；运行中则拒绝；
- 备份 `resources\app.asar.bak-<时间戳>` 与已有 watchdog；
- 复制补丁包与 `tray-restart-watchdog.cjs`；
- 复制后重新计算 SHA-256；不一致自动回滚。

### 6.3 回滚

```powershell
# 先退出 DSH
powershell -File desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -Rollback `
  -Backup "<DSH_INSTALL>\resources\app.asar.bak-<时间戳>"
```

## 7. 验证

### 7.1 构建后回读

`repack-asar.mjs` 写完后会重新解析新包，回读 `main.js` 与一个未改文件并比较哈希。
也可用安装自带 Electron 的 ASAR 读取器独立验证：

- 路径必须以 `.asar` 结尾；
- 必须使用安装自带的 Electron（`ELECTRON_RUN_AS_NODE=1`），不是 PATH 中的 Node；
- 检查 `lib/main.js` 大小/哈希、`package.json` 解析、`lib` 目录列举。

### 7.2 参考环境结果

| 项 | 值 |
|---|---|
| `lib/main.js` | 848,505 → 854,312 字节 |
| `mainPatchedSha256` | `677adcf6047b1842b0684f95175e008fdee02c2d084a9112b08c7df98cbbc1d2` |
| archive SHA-256 | `592987efc8e2162b2383f2b09462f1d70b03e217a9014737cf4933f243dce568` |
| 未改文件 | `package.json`、`lib/preload-app.cjs`、`lib` 目录列举正常 |

## 8. 完整性与签名

参考环境扫描 `DeepSeek Harness.exe` 的 Electron fuse wire：

| Fuse | 状态 |
|---|---|
| `RunAsNode` | enabled |
| `EnableCookieEncryption` | disabled |
| `EnableNodeOptionsEnvironmentVariable` | enabled |
| `EnableNodeCliInspectArguments` | enabled |
| `EnableEmbeddedAsarIntegrityValidation` | **disabled** |
| `OnlyLoadAppFromAsar` | disabled |
| `LoadBrowserProcessSpecificV8Snapshot` | disabled |
| `GrantFileProtocolExtraPrivileges` | enabled |

结论与限制：

- 参考环境中，重打包 `app.asar` 不会被 ASAR integrity 校验拒绝；
- `DeepSeek Harness.exe` 有 Authenticode 签名，`app.asar` 不是独立签名；企业策略/EDR 仍可能校验资源；
- 桌面壳更新会覆盖 `app.asar`；升级后重新运行 `check-patch.mjs`，锚点不匹配时不得复用旧补丁；
- 若未来版本开启 `EnableEmbeddedAsarIntegrityValidation`，本方案失效，应改用源码集成/官方合并；
- `RunAsNode` disabled 时，watchdog 无法运行，托盘重启仍可用但启动失败观测降级。

## 9. 补丁生成与校验

```powershell
# 从安装包提取原始 main.js（只读；使用 Electron ASAR-aware fs，见测试计划）
node desktop-shell\patch\build-patch.mjs --input <main.orig.js> --output <main.patched.js>
node desktop-shell\patch\check-patch.mjs <main.orig.js>
```

`build-patch.mjs` 要求每个锚点恰好出现一次；DSH 升级改变相关区域时会立即失败。
`check-patch.mjs` 额外检查补丁标记并执行 `node --check`。

`check-compat.mjs` 用于部署前的只读兼容性检查：

```powershell
node desktop-shell\patch\check-compat.mjs `
  --asar "<DSH_INSTALL>\resources\app.asar" `
  --exe "<DSH_INSTALL>\DeepSeek Harness.exe"
```

## 10. 故障排查

| 现象 | 检查 |
|---|---|
| 托盘没有“重启 DeepSeek Harness” | 是否真正替换 `app.asar`；`new DesktopTray` 是否在 win32 分支；启动日志 |
| 点击无反应 | `restart.log` 是否有 `restart requested`；`quitting` / `shuttingDown` 是否为 true |
| 重启后旧进程残留 | `last-result.json` 的 `residualKilled`；`restart.log` 是否 `exit-timeout` |
| 新窗口未出现但有错误框 | `code`：`spawn-error`（权限/路径）、`start-failed`、`start-unstable` |
| 重启后仍弹恢复框 | `startup.log`、`host-stderr.log`、`host-events.log` |
| `/restart-dsh` 报未安装补丁 | Host 环境是否有 `DSH_DESKTOP_RESTART_IPC=1`；补丁是否包含 Host 创建处 |
| 更新后功能消失 | 预期；重新打补丁或等待官方合并 |

日志与回执位置见 [进程生命周期](../docs/02-process-lifecycle.md) 第 8 节。

## 11. 限制

- 仅 Windows Desktop 0.2.2-rc.5；其它版本/平台不适用。
- 修改 `app.asar` 非官方支持，受签名、完整性、企业策略和更新影响。
- watchdog 只判断进程存活，不判断应用层 readiness；启动状态读取失败由 DSH 恢复框兜底。
- 强制清理只针对启动前捕获的旧进程树，不清理无关的 DSH 实例。

## 12. 相关文档

- [架构设计](../docs/01-architecture.md)
- [进程生命周期](../docs/02-process-lifecycle.md)
- [测试计划](../docs/03-test-plan.md)
- [安装指南](../INSTALL.md)
