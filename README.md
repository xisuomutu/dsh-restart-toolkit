# DSH 托盘“一键重启”补丁工具包

面向 **DeepSeek Harness Desktop 0.2.2-rc.5（Windows，Electron 桌面壳）** 的补丁工具包。

这是一个**补丁工具包**，不是可直接上架的 Cordis 插件：托盘项必须修改桌面壳 `app.asar`。工具包提供本地生成、预览、应用和回滚脚本；完整安装步骤见 [INSTALL.md](INSTALL.md)。

本目录包含两层交付：

1. **`desktop-shell/`：真正的托盘集成**。在现有 DSH 托盘右键菜单中新增“重启 DeepSeek Harness”，并完成完整退出、同路径/同参数重启、超时/启动失败/权限处理。托盘属于 Electron 桌面壳，**任何 Cordis bundle 都无法修改它**，所以这一层必须以桌面壳补丁的形式交付。
2. **`plugin/dsh-restart-command/`：可安装的 Cordis bundle**。注册 `/restart-dsh` 命令，通过桌面壳补丁提供的 IPC 触发同一套重启流程，用来验证“现有插件机制”不受影响。未打补丁时命令返回明确错误，不会擅自杀进程。

> 关键结论（已从安装包源码确认）：托盘菜单由 `resources/app.asar/lib/main.js` 中的 `DesktopTray` 类直接构建，只有“打开 / 退出”两项；Cordis 插件运行在 `dsh-desktop-host` 子进程中，桌面壳没有向插件暴露托盘扩展点。因此“纯插件改托盘菜单”在现有版本上不可行，必须改桌面壳或让官方合并。详见 [docs/01-architecture.md](docs/01-architecture.md)。

## 下载

从 GitHub Releases 下载最新工具包与校验文件（把 `<owner>/<repo>` 换成实际仓库地址）：

```text
https://github.com/xisuomutu/dsh-restart-toolkit/releases
```

附件：

- `dsh-restart-toolkit-<version>.zip`
- `dsh-restart-toolkit-<version>.zip.sha256.txt`

发布说明见 [RELEASE_NOTES.md](RELEASE_NOTES.md)，完整发布清单见 [RELEASE.md](RELEASE.md)。

## 需求对照

| # | 需求 | 实现 | 状态 |
|---|---|---|---|
| 1 | 托盘右键菜单新增“重启 DeepSeek Harness” | `desktop-shell/patch/main.js.patch`：`trayMenuTemplate` 在 Open 与分隔线之间插入 `重启 DeepSeek Harness`，保留原 Open/Quit 项与顺序 | 补丁已生成并通过锚点/语法/`git apply`/ASAR 回读校验；应用脚本默认 dry-run，**未替你改写已安装的 app.asar** |
| 2 | 完整退出，主进程/子进程不残留 | `quitWithoutConfirmation()` → 桌面壳原退出链 `finishQuit` → `backend.close()` → `DesktopHostProcess.stop()`（10s 优雅 → SIGTERM → SIGKILL）；看门狗对超时进程按 PID 逐级 `taskkill /F`（不用 `/T`，避免杀掉自身），并按重启前捕获的进程树做定向残留清理 | 代码完成，逻辑基于现有桌面壳退出链 |
| 3 | 自动重启，路径/参数一致 | `app.relaunch()` 使用当前可执行文件与 argv；看门狗快照 `process.execPath`、`process.argv.slice(1)`、`cwd`，在 `relaunch` 未生效时按快照兜底启动 | 代码完成 |
| 4 | 退出超时、启动失败、权限不足、日志/提示 | `DesktopHostProcess.stop()` 的三级超时；看门狗强制终止、启动轮询、启动后稳定期校验、`spawn-error` 权限分类、Windows 消息框、`restart.log` 与 `last-result.json` | 代码完成，看门狗有集成测试 |
| 5 | 兼容现有插件机制，不影响原托盘菜单 | 托盘补丁只**新增**一项并保留原两项；不改 profile、不改 Loader、不拦截其他插件；bundle 只注册命令，不接管进程控制 | 菜单模板有单元测试；bundle 有命令测试 |

## 目录结构

```
desktop-shell/
  runtime/tray-restart-watchdog.cjs   看门狗（独立进程，复制到 <DSH>\resources\）
  src/tray-restart.js                 源码构建用的可复用模块（菜单模板 + 重启编排）
  patch/main.js.patch                 针对已安装 lib/main.js 的 13 处精确修改（含 v2 启动重试/Host 日志）
  patch/repack-asar.mjs               生成 app.patched.asar（只附加，不改原包）
  patch/apply-patched-asar.ps1        预览 / 应用 / 回滚（默认 dry-run）
  patch/apply-after-exit.ps1          等待 DSH 退出 → 应用 → 自动重启（外部终端运行）
  patch/build-patch.mjs               从 main.js 生成补丁产物（严格锚点校验）
  patch/check-patch.mjs               只读校验：锚点、替换、语法
  patch/check-compat.mjs              只读：版本、ASAR、fuse、锚点兼容性
  test/tray-restart.test.mjs          菜单/重启编排单元测试（9 个）
  test/watchdog.test.mjs              看门狗真实进程集成测试（4 个，含“旧树包含看门狗”）
plugin/dsh-restart-command/           Cordis bundle：/restart-dsh
tests/run-all.ps1                     17 个单元/集成测试 + 可选补丁锚点检查
tests/verify-asar-patch.ps1           ASAR 补丁可复现验证（构建/回读/dry-run）
doctor.ps1                            环境/版本/ASAR/fuse 体检（只读）
package-release.ps1                   生成不含 app.asar 的发布 ZIP
INSTALL.md                            另一台 Windows 电脑的安装步骤
RELEASE_NOTES.md                      GitHub Release 说明草案
RELEASE.md                            GitHub Release 发布清单
LICENSE / NOTICE.md / DISCLAIMER.md   许可证、第三方声明、免责声明
CHANGELOG.md / VERSION                变更记录与工具包版本
docs/01-architecture.md               托盘归属、桌面壳与插件边界、方案取舍
docs/02-process-lifecycle.md          退出/重启时序、超时/失败/权限状态机
docs/03-test-plan.md                  单元、集成、手工验收矩阵
docs/04-field-notes.md                真实重启后 `fetch failed` 的现场记录与分析
```

## 已验证

在本机（Windows 11 26300，DSH 0.2.2-rc.5）实际执行：

```powershell
node --test desktop-shell/test/tray-restart.test.mjs   # 9 passed
node --test desktop-shell/test/watchdog.test.mjs       # 4 passed
node --test plugin/dsh-restart-command/test/command.test.mjs  # 4 passed
node desktop-shell/patch/check-compat.mjs --asar <app.asar> --exe <DeepSeek Harness.exe>  # OK
```

`main.js.patch` 还做了字节级验证：把补丁应用到 `app.asar/lib/main.js` 的原始副本后，结果与 `build-patch.mjs` 生成的目标文件 **SHA-256 完全一致**。若走“解包/重打包”路线（或仅用于校验），在解包目录执行：

```powershell
git -c core.autocrlf=false apply --whitespace=nowarn main.js.patch
```

`repack-asar.mjs` 生成的 `app.patched.asar` 用 **Electron 自己的 ASAR 读取器**回读通过：
`lib/main.js` 哈希与 `main.patched.js` 一致，`package.json`、`lib/preload-app.cjs` 等未改动文件字节一致。
本机还完成了真实应用、多次托盘重启和启动重试的现场验证（见 [docs/04-field-notes.md](docs/04-field-notes.md)）。

## 交付边界与风险

- 本工具包默认 dry-run；作者机器已在测试安装上应用 v3 并完成多次托盘重启，现场记录见
  [docs/04-field-notes.md](docs/04-field-notes.md)。工具包本身不包含任何 `app.asar` 或 DSH 安装包。
- 补丁只针对 **DSH Desktop 0.2.2-rc.5**。其他版本先运行 `doctor.ps1` / `check-compat.mjs`；
  锚点不匹配时不要应用。
- 这是非官方桌面壳补丁；桌面壳更新会覆盖，企业签名/ASAR 完整性策略/杀软可能阻止。保留
  `app.asar.bak-<时间戳>` 并优先在测试环境验证。
- Cordis bundle 是可选的；未打壳补丁时它只返回明确错误，不会杀进程。
- 发布/分发时不要包含 `app.asar`、备份或 DSH 二进制；保留 MIT/NOTICE 与第三方许可证；不要用
  DeepSeek 名称/Logo/签名冒充官方安装包。

## 快速使用

### 前置条件

- Windows 10/11；
- DeepSeek Harness **Desktop** 0.2.2-rc.5；
- **Node.js 20+**（构建/兼容性检查需要；`node --version`）；
- 从 **DSH 之外的 PowerShell** 应用；完整步骤见 [INSTALL.md](INSTALL.md)。

### A. 源码构建 / 可控测试构建（推荐）

1. 将 `desktop-shell/runtime/tray-restart-watchdog.cjs` 放到安装目录的 `resources/`。
2. 把 `desktop-shell/src/tray-restart.js` 集成进桌面壳 `lib/main.js`（或应用 `patch/main.js.patch`）。
3. 构建、启动，右键托盘 → “重启 DeepSeek Harness”。

### B. 给现有安装打补丁（有风险）

`desktop-shell/patch/` 里有两个配套脚本，不需要外部 ASAR 工具。先运行体检：

```powershell
powershell -File .\doctor.ps1 -InstallDir "D:\Soft\DSH"
```

如果目标安装已经打过旧补丁，`repack-asar` 不能直接读 live 包；把第 1 步输入换成
`resources\app.asar.bak-<时间戳>`，并在第 2/3 步加 `-SourceAsar "<原始备份>"`。详见
[INSTALL.md](INSTALL.md)。

**最省事的一步到位（推荐）**：从 **DSH 之外的 PowerShell/Windows Terminal** 运行，保持 DSH 开着，
然后按提示退出 DSH；脚本会等它完全退出、自动应用、再启动 DSH：

```powershell
powershell -File desktop-shell\patch\apply-after-exit.ps1 `
  -InstallDir "D:\Soft\DSH" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json"
```

> 当前 DSH 窗口会关闭；脚本完成后会用补丁版壳重新启动 DSH。重新打开后右键托盘应看到“重启 DeepSeek Harness”。
> 必须在 DSH 之外运行，否则退出 DSH 会把脚本一起终止。

**手动分步（等价）**：

```powershell
# 1) 从当前安装生成补丁副本（不改动 app.asar）；报告用于校验来源
node desktop-shell/patch/repack-asar.mjs `
  "D:\Soft\DSH\resources\app.asar" `
  "$env:TEMP\app.patched.asar" `
  --report "$env:TEMP\report.json"

# 2) 预览：校验 report 与当前 app.asar 完全匹配，不改文件
powershell -File desktop-shell/patch/apply-patched-asar.ps1 `
  -InstallDir "D:\Soft\DSH" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json"

# 3) 完全退出 DSH（托盘退出 + 任务管理器确认）后应用；自动备份 + 回滚命令
powershell -File desktop-shell/patch/apply-patched-asar.ps1 `
  -InstallDir "D:\Soft\DSH" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json" `
  -Apply
```

> `-Apply` 请从 **DSH 之外的 PowerShell/Windows Terminal** 运行，不要用 DSH 内置终端：关闭 DSH 会终止
> 内置终端。脚本先把补丁复制到 `app.asar.new`、校验哈希，再原子移动到 `app.asar`，中断时原包仍在；
> 并保留 `app.asar.bak-<时间戳>`。

`repack-asar.mjs` 只复制原包、改 JSON 头中 `lib/main.js` 一项、把新 main.js 追加到末尾；其余
21,721 个文件的 offset 与字节不变。报告含输入/输出 SHA-256，部署脚本会拒绝“补丁不是从当前安装生成”的情况。
**升级、签名、完整性校验仍可能使该路径失效；官方源码构建是更稳的方式。**

### C. 安装 Cordis bundle（需要先完成 A 或 B 的壳补丁）

插件管理 → 添加插件 → 选择绝对路径：

```text
D:\Tools\dsh-restart-toolkit\plugin\dsh-restart-command
```

之后在命令面板执行 `/restart-dsh`。未打壳补丁时命令会明确提示缺少 `DSH_DESKTOP_RESTART_IPC`。

## 发布工具包

发布的是**补丁工具包**，不是 DSH 插件市场包，也不包含 `app.asar`。

```powershell
powershell -File .\doctor.ps1 -InstallDir "D:\Soft\DSH"
powershell -File .\package-release.ps1
```

输出：

```text
dist\dsh-restart-toolkit-1.0.0.zip
dist\dsh-restart-toolkit-1.0.0.zip.sha256.txt
```

ZIP 包含脚本、watchdog、文档、可选 bundle、测试、许可证和打包脚本；**不包含** `app.asar`、
`app.asar.bak-*`、日志、`node_modules` 或本机补丁副本。

公开发布前检查：

- `VERSION` / `CHANGELOG.md` / `INSTALL.md` 已更新；
- `doctor.ps1` 在干净机器上通过，版本/锚点/fuse 提示正确；
- 不包含 `app.asar`/备份/本机日志；不包含 DeepSeek 二进制或官方签名安装包；
- 保留 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md)、[DISCLAIMER.md](DISCLAIMER.md) 和第三方许可证；
- 说明这是非官方补丁、Windows/Desktop/0.2.2-rc.5 限制，以及备份/回滚方式。

## 为什么没有在插件里直接 `taskkill`

Cordis Host 进程由桌面壳以 `stdio: ['ignore','pipe','pipe','ipc']` 启动（`main.js` 11782–11802），它知道自己的父进程，但不知道桌面壳的完整启动环境、单实例锁状态和退出确认流程。插件擅自 `taskkill /T /F` 父进程会绕过桌面壳的 `finishQuit`，可能留下 Host、终端、MCP 子进程，也无法在壳退出后向用户报告启动失败。正确做法是让**拥有托盘和生命周期的桌面壳**执行 `app.relaunch()` + 自身退出链；看门狗只做壳退出后的观测与兜底。
