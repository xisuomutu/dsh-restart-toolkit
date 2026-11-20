# 桌面壳托盘补丁

本目录是“重启 DeepSeek Harness”托盘项的唯一正确落点。原因见 [../docs/01-architecture.md](../docs/01-architecture.md)：
托盘由 Electron 桌面壳创建，Cordis bundle 运行在 Host 子进程，没有托盘扩展点。

## 补丁改了什么

`patch/main.js.patch` 对 `resources/app.asar/lib/main.js` 做 13 处精确修改：

| # | 位置 | 修改 |
|---|---|---|
| 1 | `lib/types/tray.js` | 新增 `trayMenuTemplate(messages, actions)`；Open/Quit 完全保留，Restart 插在两者之间；标签为 `messages.restartApplication + " DSH"`（复用壳已有本地化） |
| 2 | `DesktopTray.relabel()` | 用模板构建菜单，并调用新增的 `restart` 回调 |
| 3 | `main()`（`let quitting` 之后） | 新增 `restartFromTray()`：单飞、快照、拉起看门狗、`app.relaunch()`、`quitWithoutConfirmation()`、失败弹框 |
| 4 | `new DesktopTray({...})` | 注入 `restart: () => restartFromTray()` |
| 5 | `isDesktopHostEvent()` | 接受 Host 的 `restart-app` 消息（仅整数 `requestId`） |
| 6 | `DesktopHostProcess` 字段 | 增加 `onRestartRequest` |
| 7 | 构造器/JSDoc | 增加 `onRestartRequest` 参数 |
| 8 | 构造器赋值 | 保存 `onRestartRequest` |
| 9 | Host 消息处理 | 收到 `restart-app` 时调用 `onRestartRequest` |
| 10 | Host 创建处 | 注入 `DSH_DESKTOP_RESTART_IPC=1`，并传第 11 个参数 `() => restartFromTray()` |
| 11 | Host stderr 处理 | 追加写入 `tray-restart/host-stderr.log`（诊断 Host 启动/退出） |
| 12 | `openInitialWindow()` | 新增 `readWelcomeStateWithRetry()`：对 `ECONNRESET`/`fetch failed` 等瞬时错误最多重试 2 次，写 `tray-restart/startup.log` |
| 13 | Host `close` 处理 | 追加写入 `tray-restart/host-events.log`（退出码 + stderr 尾部） |

### v2 硬化说明

真实重启测试中，新实例在 Host 刚就绪、shell 读取 `readWelcomeState()` 时收到可复现的
`fetch failed / ECONNRESET`，触发 DSH 自带恢复对话框（详见 [../docs/04-field-notes.md](../docs/04-field-notes.md)）。
v2 增加两项**针对性**修改：

- 启动状态读取遇到瞬时连接错误时重试（3 次尝试，间隔 300/600ms），避免一次 socket 重置直接进入致命恢复；
- Host stderr 与 close 事件落盘，下一次若仍失败，可直接确认 Host 是否退出、退出码和 stderr。

这两项不改退出链、认证协议、Host 启动参数或插件 Loader；若重试仍失败，`startup.log` 与 `host-events.log`
会给出证据，再决定是否禁用第三方插件或进一步修复。

**现场验证（2026-11-19 18:12）**：应用 v2 后，托盘重启在旧故障同一时刻触发
`welcome-state read failed (attempt 1): fetch failed ECONNRESET; retrying`，重试后正常打开；无新增
crash report；`host-events.log` 为 `close code=0`。详见 [../docs/04-field-notes.md](../docs/04-field-notes.md)。

看门狗不是内联在补丁里的：补丁从 `resources/tray-restart-watchdog.cjs` 加载。若该文件不存在，仍会
`app.relaunch()` + 退出，只是失去启动失败观测。

补丁**不**修改：现有 Open/Quit 的点击逻辑、托盘图标、工具提示、其它菜单、profile、插件 Loader。

## 文件

```
runtime/tray-restart-watchdog.cjs   复制到 <DSH 安装目录>\resources\
src/tray-restart.js                 源码构建用的可测试模块（等价逻辑）
patch/main.js.patch                 针对 0.2.2-rc.5 已安装 bundle 的补丁
patch/build-patch.mjs               严格锚点替换，生成 main.patched.js
patch/check-patch.mjs               只读校验锚点/语法
patch/check-compat.mjs              只读检查版本/ASAR/fuse/锚点兼容性
patch/repack-asar.mjs               生成 app.patched.asar（附加式，不改原包）
patch/apply-patched-asar.ps1        预览 / 应用 / 回滚（默认 dry-run）
patch/apply-after-exit.ps1          等待 DSH 退出 → 应用 → 重启（外部终端）
test/*.test.mjs                     单元与看门狗集成测试
```

## 方案 A：源码构建 / 厂商合并（推荐）

1. 把 `src/tray-restart.js` 放进桌面壳源码（例如 `lib/tray-restart.ts` 编译产物），在 shell 入口导入
   `createTrayRestart` 与 `trayMenuTemplate`。
2. 在创建 `DesktopTray` 时传入 `restart` 回调；`relabel()` 使用 `trayMenuTemplate`。
3. 在 `DesktopHostProcess` 中增加 `restart-app` 处理，并给 Host 环境加
   `DSH_DESKTOP_RESTART_IPC=1`（与补丁一致）。
4. 构建时把 `runtime/tray-restart-watchdog.cjs` 作为 extraResource 复制到 `resources/`。
5. 运行 `desktop-shell/test/*.test.mjs`；按 [../docs/03-test-plan.md](../docs/03-test-plan.md) 验收。

源码构建不需要改 `app.asar`，也不会被 ASAR integrity 拒绝；后续升级只需重新构建。

## 方案 B：给已安装应用打补丁（仅测试副本）

> **风险**：会修改 `resources/app.asar`，绕过官方签名/完整性校验；桌面壳更新会覆盖；应用了不匹配的
> 补丁可能导致无法启动。先备份，且只在测试副本上操作。本目录的补丁器不需要 `@electron/asar`，
> 但它仍然不是官方支持的部署方式。

### 附加式 ASAR 补丁怎么工作

`repack-asar.mjs` **不重新打包 209 MB 的文件**：

1. 复制原始 `app.asar`；
2. 只改 JSON 头里的 `lib/main.js` 一项（`offset` 指到末尾、`size` 改成新长度、删掉它的 `integrity`）；
3. 新 `main.js` 追加到文件末尾；
4. 其余 21,721 个文件的 offset 和字节完全不变；头部 JSON 槽位等长，用空格填充；
5. 报告包含输入/输出 SHA-256、新旧 main.js 哈希/offset。

输出是一个**新文件**，脚本不会覆盖输入包。部署脚本会校验“报告里的输入哈希 == 当前安装的 app.asar”，
防止拿旧版本的补丁去覆盖新版本。

### 步骤

**推荐：一步到位（从 DSH 之外的 PowerShell 运行，保持 DSH 开着，按提示退出 DSH）：**

```powershell
powershell -File desktop-shell\patch\apply-after-exit.ps1 `
  -InstallDir "D:\Soft\DSH" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json"
```

脚本先 dry-run 校验，然后等待所有 `DeepSeek Harness.exe` 退出（默认 300s），应用补丁并自动启动 DSH。
当前会话窗口会关闭；重新打开后托盘应出现“重启 DeepSeek Harness”。

**手动分步：**

```powershell
# 1) 生成补丁副本（不改安装）
node desktop-shell\patch\repack-asar.mjs `
  "D:\Soft\DSH\resources\app.asar" `
  "$env:TEMP\app.patched.asar" `
  --report "$env:TEMP\report.json"

# 2) 预览：校验来源哈希、列出备份路径；不改文件
powershell -File desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "D:\Soft\DSH" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json"

# 3) 完全退出 DSH（托盘退出 + 任务管理器确认）后应用
powershell -File desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "D:\Soft\DSH" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json" `
  -Apply
```

> 从 **DSH 之外的 PowerShell/Windows Terminal** 运行 `-Apply`。不要使用 DSH 内置终端：关闭 DSH 会
> 终止内置终端。脚本先把补丁复制到 `app.asar.new`、校验哈希，再移动到 `app.asar`；中断时原包仍在。

应用脚本会：

- 检测 `DeepSeek Harness.exe` 是否仍在运行；在运行则拒绝；
- 备份 `resources\app.asar.bak-<时间戳>`，并备份已有 watchdog（如有）；
- 复制补丁包和 `tray-restart-watchdog.cjs`；
- 复制后重新计算 SHA-256，不一致自动回滚。

启动 DSH，右键托盘验收；日志在 `%APPDATA%\@deepseek-ai\dsh-desktop\tray-restart\restart.log`。

### 回滚

```powershell
# 退出 DSH 后
powershell -File desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "D:\Soft\DSH" `
  -Rollback `
  -Backup "D:\Soft\DSH\resources\app.asar.bak-<时间戳>"
```

### 验证附加式补丁

`repack-asar.mjs` 会在写完后重新解析新包、回读 `main.js` 与一个未改文件并比较。还可以用 Electron 的
ASAR 读取器做独立验证（路径必须以 `.asar` 结尾，且要用安装自带的 Electron，而不是 PATH 里的 Node）。

本机已执行：`main.js` 848,505 → 854,312 字节，`lib/main.js` 回读哈希
`677adcf6047b1842b0684f95175e008fdee02c2d084a9112b08c7df98cbbc1d2` 与 `build-patch.mjs` 输出一致；
归档 `592987ef…e568`；`package.json`、`lib/preload-app.cjs`、`lib` 目录列举均正常。

### 完整性/签名

本机 0.2.2-rc.5 的 Electron fuse 实读结果（扫描 `DeepSeek Harness.exe` 的 fuse wire）：

| Fuse | 状态 |
|---|---|
| `RunAsNode` | enabled |
| `EnableCookieEncryption` | enabled |
| `EnableNodeOptionsEnvironmentVariable` | enabled |
| `EnableNodeCliInspectArguments` | enabled |
| `EnableEmbeddedAsarIntegrityValidation` | **disabled** |
| `OnlyLoadAppFromAsar` | disabled |
| `LoadBrowserProcessSpecificV8Snapshot` | disabled |
| `GrantFileProtocolExtraPrivileges` | enabled |

因此本机重打包 `app.asar` **不会**被 ASAR integrity 校验拒绝；但这不等于官方支持：

- `DeepSeek Harness.exe` 本身有有效的 Authenticode 签名；`app.asar` 不是独立签名的，但企业策略/EDR
  可能对资源做哈希校验。
- 桌面壳更新会覆盖 `app.asar`；升级后重新运行 `check-patch.mjs`，锚点不匹配时**不要**复用旧补丁。
- 若未来版本开启 `EnableEmbeddedAsarIntegrityValidation`，方案 B 立即失效，改用方案 A。

## 生成/校验补丁

```powershell
# 从安装包复制出原文件（只读；用 Electron 的 ASAR-aware fs）
# 见 docs/03-test-plan.md 的命令
node desktop-shell\patch\build-patch.mjs --input <main.orig.js> --output <main.patched.js>
node desktop-shell\patch\check-patch.mjs <main.orig.js>
```

`build-patch.mjs` 要求每个锚点**恰好出现一次**；DSH 升级改动这些区域时会立即失败，避免半应用补丁。
`check-patch.mjs` 额外检查 6 个新标记并执行 `node --check`。

## 排错

| 现象 | 检查 |
|---|---|
| 托盘没有“重启 DeepSeek Harness” | 是否真的替换了 `app.asar`；`main()` 里 `new DesktopTray` 是否在 win32 分支；启动日志 |
| 点击无反应 | `restart.log` 是否有 `restart requested`；`quitting`/`shuttingDown` 是否已为 true |
| 重启后旧进程残留 | `last-result.json` 的 `residualKilled`；`restart.log` 是否 `exit-timeout` |
| 新窗口没出现但有错误框 | `code`：`spawn-error`（权限/路径）、`start-failed`、`start-unstable`（启动即崩） |
| 插件 `/restart-dsh` 报未安装补丁 | Host 环境是否有 `DSH_DESKTOP_RESTART_IPC=1`；补丁是否包含 Host 创建处那行 |
| 更新后功能消失 | 预期；重新打补丁或等待官方合并 |
