# DSH Restart Toolkit

**面向 DeepSeek Harness Desktop 0.2.2-rc.5 的非官方 Windows 补丁工具包，为托盘添加“重启 DeepSeek Harness”。**

| 项 | 值 |
|---|---|
| 工具包版本 | 1.0.0 |
| 补丁版本 | v3 |
| 适用 DSH | DeepSeek Harness Desktop 0.2.2-rc.5 |
| 平台 | Windows 10/11 |
| 许可证 | MIT |

> 本项目不是 DSH 官方项目，也不隶属、背书或赞助于 DeepSeek。托盘属于 Electron 桌面壳，
> 工具包通过修改本地 `app.asar` 实现，必须按安装指南在本地生成补丁。

## 1. 概述

DSH Restart Toolkit 提供一套可验证、可回滚的桌面壳补丁，用于在 DSH 原生托盘菜单中增加
“重启 DeepSeek Harness”。重启过程复用桌面壳自身的 `app.relaunch()` 与
`quitWithoutConfirmation()` 退出链，不绕过 Host 和插件的清理逻辑。

工具包包含：

- 桌面壳补丁（托盘项、重启编排、受控 IPC、启动重试、Host 日志）；
- 独立 watchdog（观察退出/启动、超时清理、回执和错误提示）；
- 附加式 ASAR 补丁器（不重打包全部文件）；
- 安装、预检、应用、回滚和发布脚本；
- 可选的 `/restart-dsh` Cordis bundle。

## 2. 功能

| 功能 | 说明 |
|---|---|
| 托盘重启 | 在原生托盘菜单中新增“重启 DeepSeek Harness”，保留原“打开/退出”项 |
| 完整退出 | `finishQuit()` → `backend.close()` → `DesktopHostProcess.stop()`，10s / 5s / 5s 逐级升级 |
| 同参重启 | `app.relaunch()` 使用当前可执行文件和 argv；watchdog 在必要时按快照兜底 |
| watchdog | 等待旧进程退出、校验新实例、稳定期检查；超时按 PID 清理旧树，不使用 `/T` |
| 启动加固 | 对欢迎状态 RPC 的瞬时 `ECONNRESET` 重试 3 次，并写 Host 日志 |
| 预检 | `doctor.ps1` / `check-compat.mjs` 检查版本、ASAR、Electron fuse 和补丁锚点 |
| 安全部署 | report/source 校验、暂存替换、自动备份、失败回滚 |
| 可选命令 | `/restart-dsh` 通过桌面壳 `restart-app` IPC 触发同一重启路径 |

## 3. 系统要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 |
| DSH | DeepSeek Harness **Desktop 0.2.2-rc.5** |
| Node.js | 20+，`PATH` 中可执行 `node`（构建/校验需要） |
| PowerShell | 5.1（Windows 自带） |
| 权限 | 安装目录可写；位于 `Program Files` 时需要管理员 |
| 终端 | 应用步骤必须从 DSH 之外的 PowerShell / Windows Terminal 运行 |

## 4. 下载

从 GitHub Releases 下载最新工具包与校验文件：

- <https://github.com/xisuomutu/dsh-restart-toolkit/releases>
- 附件：`dsh-restart-toolkit-<version>.zip` 与 `.zip.sha256.txt`

ZIP **不包含** `app.asar`、`app.asar.bak-*`、日志、`node_modules` 或 DeepSeek 二进制；
补丁必须用本地安装生成。

## 5. 快速开始

完整步骤、兼容性判断和回滚见 [INSTALL.md](INSTALL.md)。

```powershell
# 1. 环境检查（只读）
powershell -File .\doctor.ps1 -InstallDir "<DSH_INSTALL>"

# 2. 从本地 app.asar 生成补丁副本（只读）
New-Item -ItemType Directory -Force -Path "$env:TEMP\dsh-local" | Out-Null
node .\desktop-shell\patch\repack-asar.mjs `
  "<DSH_INSTALL>\resources\app.asar" `
  "$env:TEMP\dsh-local\app.patched.asar" `
  --report "$env:TEMP\dsh-local\report.json"

# 3. 预检（不写文件）
powershell -File .\desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\dsh-local\app.patched.asar" `
  -Report "$env:TEMP\dsh-local\report.json"

# 4. 应用并重启（在 DSH 之外的 PowerShell 中运行）
powershell -File .\desktop-shell\patch\apply-after-exit.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\dsh-local\app.patched.asar" `
  -Report "$env:TEMP\dsh-local\report.json"
```

如果目标安装已经打过补丁，必须使用原始 `resources\app.asar.bak-<时间戳>` 作为构建输入，
并在应用步骤加 `-SourceAsar`；详见 [INSTALL.md](INSTALL.md)。

## 6. 架构

托盘由桌面壳主进程的 `DesktopTray` 创建，Cordis 插件运行在 Host 子进程，二者之间没有托盘
扩展点。因此：

- **必须**由桌面壳补丁新增菜单项并执行重启；
- watchdog 只做桌面壳退出后的进程观测，不负责 UI/应用层 readiness；
- 可选 bundle 只复用壳的 `restart-app` IPC，不直接杀进程。

```text
Desktop shell (Electron main)
├─ DesktopTray          + 重启菜单项
├─ restartFromTray()    → snapshot → watchdog → app.relaunch() → quitWithoutConfirmation()
└─ restart-app IPC      ← optional /restart-dsh bundle
        │
        ▼
finishQuit → backend.close → DesktopHostProcess.stop (10s/5s/5s)
        │
        ▼
watchdog: old exit → new instance → settle → cleanup → receipt
```

详细设计见 [docs/01-architecture.md](docs/01-architecture.md) 与
[desktop-shell/README.md](desktop-shell/README.md)。

## 7. 仓库结构

```text
desktop-shell/             桌面壳补丁、watchdog、构建/部署脚本、测试
plugin/dsh-restart-command 可选 Cordis bundle：/restart-dsh
docs/                      架构、生命周期、测试计划
tests/                     测试运行器与 ASAR 可复现验证
doctor.ps1                 环境/版本/ASAR/fuse/锚点检查
package-release.ps1        生成不含 app.asar 的发布 ZIP
INSTALL.md                 安装、升级、回滚
RELEASE_NOTES.md           当前版本发布说明
CHANGELOG.md               变更记录
LICENSE / NOTICE.md / DISCLAIMER.md
```

## 8. 验证

参考环境（Windows 11、DSH Desktop 0.2.2-rc.5）执行结果：

| 项 | 结果 |
|---|---|
| 自动化测试 | 17/17 通过（托盘 9、watchdog 4、命令 4） |
| 环境/兼容性 | `doctor.ps1`：锚点匹配、ASAR integrity disabled、RunAsNode enabled |
| ASAR 回读 | `lib/main.js` 854,312 字节，哈希 `677adcf6…`，与构建输出一致 |
| 归档哈希 | v3 `592987efc8e2162b2383f2b09462f1d70b03e217a9014737cf4933f243dce568` |
| 实机验证 | v2 启动重试捕获 `ECONNRESET` 后恢复，无新增 crash report，Host `close code=0` |

测试方法与证据见 [docs/03-test-plan.md](docs/03-test-plan.md)。

## 9. 安全与限制

- **非官方**：修改 `app.asar` 不是受支持的扩展方式；使用风险自负。
- **版本绑定**：仅针对 0.2.2-rc.5；升级后必须重新运行 `doctor.ps1`，锚点不匹配不得应用。
- **完整性/签名**：ASAR integrity、Authenticode、企业策略、EDR/杀毒可能阻止修改后的归档。
- **更新覆盖**：桌面壳升级会覆盖补丁；需重新应用或改用源码集成/官方合并。
- **数据**：重启会中断正在运行的回合、工具、终端和后台任务；会话日志持久化，进行中的工作不会保留。
- **分发**：不得分发 `app.asar`、备份或 DeepSeek 二进制；不得使用 DeepSeek 名称/Logo/签名冒充官方。

## 10. 文档

| 文档 | 内容 |
|---|---|
| [INSTALL.md](INSTALL.md) | 安装、升级、回滚 |
| [docs/README.md](docs/README.md) | 文档索引与约定 |
| [docs/01-architecture.md](docs/01-architecture.md) | 架构与设计决策 |
| [docs/02-process-lifecycle.md](docs/02-process-lifecycle.md) | 重启时序、watchdog、超时与日志 |
| [docs/03-test-plan.md](docs/03-test-plan.md) | 测试计划与验收矩阵 |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | 当前版本发布说明 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |

## 11. 许可证

工具包采用 MIT 许可证，见 [LICENSE](LICENSE)。DeepSeek Harness 采用 MIT 许可证，
Copyright (c) 2026 DeepSeek；Electron/Chromium 组件带有各自许可证。第三方声明与使用限制见
[NOTICE.md](NOTICE.md) 和 [DISCLAIMER.md](DISCLAIMER.md)。
