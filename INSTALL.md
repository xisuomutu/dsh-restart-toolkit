# 在另一台 Windows 电脑上安装

本工具包**不包含** DeepSeek Harness 的安装包、`app.asar` 或任何备份。它需要在你自己的
DSH 安装上本地生成补丁。

## 0. 前置条件

- Windows 10/11；
- **DeepSeek Harness Desktop 0.2.2-rc.5**（Settings/About 或安装目录 `package.json`）；
- PowerShell 5.1（Windows 自带）；
- **Node.js 20+** 在 PATH 中（构建、兼容性检查需要；`node --version` 可验证）；
- 安装目录可写；如果 DSH 装在 `Program Files` 下，需要管理员权限；
- 从 **DSH 之外的 PowerShell/Windows Terminal** 运行应用步骤。

把整个工具包目录放在一个固定、可写的位置，例如 `D:\Tools\dsh-restart-toolkit`。
不要把工具包放在 `%TEMP%`，否则重启后可能被清理。

## 1. 先体检

```powershell
cd <工具包目录>
powershell -File .\doctor.ps1 -InstallDir "<DSH_INSTALL>"
```

`<DSH_INSTALL>` 是包含 `DeepSeek Harness.exe` 和 `resources\` 的目录。

体检会显示：

- DSH 版本、`app.asar` 哈希、是否已在运行；
- 备份、watchdog、磁盘空间、管理员状态；
- 当前 Electron fuse（尤其 ASAR integrity 与 RunAsNode）；
- 补丁锚点是否与当前 `main.js` 兼容。

如果提示 **ASAR integrity validation is enabled**，不要继续应用；该构建可能拒绝修改后的
`app.asar`，应改用源码构建或官方合并。
如果提示 **RunAsNode fuse is disabled**，托盘重启仍可用，但 watchdog 无法运行，启动失败
检测会降级。

## 2. 生成补丁副本（只读，不改安装）

如果 DSH 仍是**原始未打补丁**状态：

```powershell
New-Item -ItemType Directory -Force -Path "$env:TEMP\dsh-local" | Out-Null

node .\desktop-shell\patch\repack-asar.mjs `
  "<DSH_INSTALL>\resources\app.asar" `
  "$env:TEMP\dsh-local\app.patched.asar" `
  --report "$env:TEMP\dsh-local\report.json"
```

脚本会校验锚点、生成补丁包、写报告；不会修改安装目录。

如果 DSH **已经打过旧补丁**，当前 `app.asar` 的 `main.js` 已包含托盘代码，锚点会失败。此时
需要用**原始备份**作为输入（`app.asar.bak-<时间戳>`）：

```powershell
node .\desktop-shell\patch\repack-asar.mjs `
  "<DSH_INSTALL>\resources\app.asar.bak-<时间戳>" `
  "$env:TEMP\dsh-local\app.patched.asar" `
  --report "$env:TEMP\dsh-local\report.json"
```

后续应用时加 `-SourceAsar "<原始备份>"`，让报告校验仍然有效。没有原始备份时，不要强行
重建；恢复一份原始 DSH 安装后再操作。

## 3. 预览

```powershell
powershell -File .\desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\dsh-local\app.patched.asar" `
  -Report "$env:TEMP\dsh-local\report.json"
```

只有原始包时不需要 `-SourceAsar`；已经打过补丁、从备份构建时加：

```powershell
  -SourceAsar "<DSH_INSTALL>\resources\app.asar.bak-<时间戳>"
```

预览不会改文件；确认 `Report verified`、路径、备份路径和运行状态。

## 4. 应用并重启

保持 DSH 运行也可以，脚本会等待你退出：

```powershell
powershell -File .\desktop-shell\patch\apply-after-exit.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\dsh-local\app.patched.asar" `
  -Report "$env:TEMP\dsh-local\report.json"
```

如果从原始备份构建，同样加 `-SourceAsar "<备份>"`。

脚本会：

1. 再跑一次 dry-run 校验；
2. 等待所有 `DeepSeek Harness.exe` 退出（默认 300 秒）；
3. 备份当前 `app.asar`，把新包暂存、校验、替换；
4. 复制 `tray-restart-watchdog.cjs` 到 `resources\`；
5. 重新启动 DSH。

当前 DSH 窗口会关闭，几秒后重新打开。

## 5. 验证

右键托盘，应看到：

```text
打开 DeepSeek Harness
重启 DeepSeek Harness
──────────────
退出 DeepSeek Harness
```

点击“重启 DeepSeek Harness”，应完整退出并以相同路径/参数重新打开。

日志：

```text
%APPDATA%\@deepseek-ai\dsh-desktop\tray-restart\
  restart.log
  last-result.json
  startup.log        （v2 启动重试）
  host-stderr.log    （Host stderr）
  host-events.log    （Host close 事件）
```

## 6. 可选：`/restart-dsh` 命令

托盘功能不依赖此插件。需要命令时：

**设置 → 插件 → 添加插件**，选择：

```text
<工具包目录>\plugin\dsh-restart-command
```

未打壳补丁时它只返回“未安装托盘补丁”，不会杀进程。

## 7. 回滚

应用脚本会打印备份路径，例如：

```powershell
powershell -File .\desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -Rollback `
  -Backup "<DSH_INSTALL>\resources\app.asar.bak-<时间戳>"
```

回滚前先完全退出 DSH。watchdog 文件可以保留；未打补丁的壳不会使用它。

## 8. 版本不匹配 / 更新后

- 锚点失败或 `doctor.ps1` 显示不兼容：**停止**，不要强制应用。当前补丁只针对
  0.2.2-rc.5。
- DSH 桌面壳升级会覆盖 `app.asar`；升级后重新运行 `doctor.ps1`，从新安装的原始
  `app.asar` 重新生成补丁、预览、应用。
- 不要把本工具包生成的 `app.patched.asar` 发给别人；每台电脑都应从自己的安装生成。

## 9. 不要做的事

- 不要分发 `app.asar`、`app.asar.bak-*`、DeepSeek Harness 安装包或本机补丁副本；
- 不要用官方名称/Logo/签名冒充官方安装包；
- 不要在版本不匹配时强行应用；
- 不要在 DSH 内置终端里运行 `-Apply`/`apply-after-exit.ps1`（退出 DSH 会终止终端）；
- 不要删除原始备份，直到你确认新版本稳定。
