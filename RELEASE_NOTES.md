# DSH Restart Toolkit 1.0.0

> 发布日期：2026-11-20  
> 适用平台：Windows 10/11  
> 适用 DSH：DeepSeek Harness Desktop 0.2.2-rc.5  
> 许可：MIT

## 1. 概述

**非官方 Windows 补丁工具包**，为 DSH Desktop 的原生托盘菜单添加“重启 DeepSeek Harness”，
并执行一次完整、可验证的桌面重启。

本项目不是 DSH 插件市场包。托盘属于 Electron 桌面壳，工具包通过修改本地 `app.asar`
实现，并提供备份、校验和回滚。

## 2. 主要变更

### 2.1 托盘与重启

- 新增托盘项 `重启 DeepSeek Harness` / `Restart DeepSeek Harness`，位于原有“打开/退出”项旁；
- 通过桌面壳现有 `app.relaunch()` + `quitWithoutConfirmation()` 路径重启；
- 完整退出链：`backend.close()` → `DesktopHostProcess.stop()`，10 秒 / 5 秒 / 5 秒逐级升级；
- 幂等保护：进行中/退出中的重复请求直接拒绝。

### 2.2 watchdog

- 独立进程，等待旧进程退出并校验新实例；
- 25 秒启动观察、2.5 秒稳定期、30 秒退出超时；
- 超时后按 PID 从叶子到根清理旧进程树，不使用 `/T`，排除 conhost；
- 写入 `restart.log` / `last-result.json`，失败时弹出提示。

### 2.3 启动加固

- 欢迎状态 RPC 对瞬时 `ECONNRESET` / `fetch failed` 最多重试 3 次；
- 写入 `startup.log`、`host-stderr.log`、`host-events.log`，用于区分 Host 崩溃与连接重置。

### 2.4 补丁与部署

- 附加式 ASAR 补丁：不完整重打包，其余 21,721 个条目保持偏移和字节；
- `doctor.ps1` / `check-compat.mjs`：版本、ASAR、Electron fuse、锚点兼容性检查；
- `apply-patched-asar.ps1`：report/source 校验、暂存替换、自动备份、回滚；
- `apply-after-exit.ps1`：等待 DSH 退出、应用并重启。

### 2.5 可选命令

- Cordis bundle 注册 `/restart-dsh`，通过 `restart-app` IPC 触发同一重启路径；
- 未打壳补丁时返回明确错误，不杀进程。

## 3. 系统要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 |
| DSH | DeepSeek Harness Desktop 0.2.2-rc.5 |
| Node.js | 20+，`PATH` 中可执行 |
| PowerShell | 5.1 |
| 终端 | 应用步骤从 DSH 之外的 PowerShell / Windows Terminal 运行 |

## 4. 安装

1. 下载 `dsh-restart-toolkit-1.0.0.zip` 与 `.sha256.txt`；
2. 解压到固定目录；
3. 运行 `doctor.ps1`；
4. 从本地 `app.asar` 生成补丁；
5. dry-run；
6. 应用并重启；
7. 验证托盘项。

完整命令与兼容性判断见 [INSTALL.md](INSTALL.md)。

## 5. 验证

| 项 | 结果 |
|---|---|
| 自动化测试 | 17/17 通过（托盘 9、watchdog 4、命令 4） |
| 环境检查 | 锚点匹配、ASAR integrity disabled、RunAsNode enabled |
| 构建回读 | `lib/main.js` 854,312 字节，哈希 `677adcf6…` |
| 归档哈希 | `592987efc8e2162b2383f2b09462f1d70b03e217a9014737cf4933f243dce568` |
| 实机验证 | v2 启动重试捕获 `ECONNRESET` 后恢复，无新增 crash report，Host `close code=0` |

详细测试与证据见 [docs/03-test-plan.md](docs/03-test-plan.md)。

## 6. 兼容性与限制

- 非官方，不隶属 DeepSeek；使用风险自负；
- 仅支持 Windows Desktop 0.2.2-rc.5；其它版本/构建可能锚点失败，不得强行应用；
- ASAR 完整性、代码签名、企业策略、杀毒或更新可能阻止/覆盖补丁；
- 保留自动生成的 `app.asar.bak-<timestamp>`，应用无法启动时回滚；
- 重启会中断正在运行的轮次、工具、终端和任务；会话日志持久化，进行中的工作不会保留；
- 不得分发 `app.asar`、备份或 DeepSeek 二进制。

## 7. 校验和

ZIP 的 SHA-256 见附件：

```text
dsh-restart-toolkit-1.0.0.zip.sha256.txt
```

下载后校验：

```powershell
Get-FileHash .\dsh-restart-toolkit-1.0.0.zip -Algorithm SHA256
Get-Content .\dsh-restart-toolkit-1.0.0.zip.sha256.txt
```

## 8. 许可证与声明

工具包采用 MIT 许可证。DeepSeek Harness 采用 MIT 许可证，Copyright (c) 2026 DeepSeek；
Electron/Chromium 组件带有各自许可证。详见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md)、
[DISCLAIMER.md](DISCLAIMER.md)。
