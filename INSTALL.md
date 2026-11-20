# 安装指南

> 文档状态：已发布  
> 适用范围：DSH Desktop 0.2.2-rc.5（Windows 10/11）  
> 工具包版本：1.0.0  
> 相关文档：[README](README.md) · [变更记录](CHANGELOG.md) · [测试计划](docs/03-test-plan.md)

## 1. 适用范围

本指南用于在一台 Windows 电脑上安装 DSH Restart Toolkit：从本地 DSH 的 `app.asar` 生成补丁、
预检、应用、验证和回滚。

本工具包**不包含** DeepSeek Harness 安装包、`app.asar` 或任何备份；补丁必须在目标机器本地生成。

## 2. 兼容性

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 |
| DSH | DeepSeek Harness **Desktop 0.2.2-rc.5** |
| 桌面壳 | Windows Electron 桌面版（非 `dsh web` / CLI） |
| Node.js | 20+，`PATH` 中可执行 `node` |
| PowerShell | 5.1 |
| 权限 | 安装目录可写；位于 `Program Files` 时需要管理员 |
| ASAR integrity | `EnableEmbeddedAsarIntegrityValidation` 必须为 disabled |
| RunAsNode | 建议 enabled；disabled 时 watchdog 无法运行，启动失败观测降级 |

版本不匹配时，补丁锚点会失败。**不得**在未通过 `doctor.ps1` 的安装上强行应用。

## 3. 前置条件

1. 将工具包解压到固定、可写目录，例如 `D:\Tools\dsh-restart-toolkit`；不要放在 `%TEMP%`。
2. 确认 DSH 版本（Settings/About 或安装目录 `package.json`）。
3. 确认 `node --version` 输出 20+。
4. 应用步骤必须从 **DSH 之外的 PowerShell / Windows Terminal** 运行；DSH 内置终端会随
   DSH 退出而终止。
5. 保留一份可用的原始 `app.asar` 备份（应用脚本会自动创建，但建议确认已有备份）。

## 4. 安装流程

```text
环境检查 → 生成补丁副本 → 预检 → 应用并重启 → 验证
                              └─ 失败 → 回滚
```

所有命令中的 `<DSH_INSTALL>` 指包含 `DeepSeek Harness.exe` 和 `resources\` 的目录，例如
`D:\Soft\DSH`。

## 5. 环境检查

```powershell
cd <工具包目录>
powershell -File .\doctor.ps1 -InstallDir "<DSH_INSTALL>"
```

检查内容：

- DSH 版本、`app.asar` 哈希、是否正在运行；
- 备份、watchdog、磁盘空间、管理员状态；
- Electron fuse（重点：ASAR integrity、RunAsNode）；
- 补丁锚点与当前 `main.js` 的兼容性。

处理规则：

| 结果 | 处理 |
|---|---|
| `READY` | 继续安装 |
| `ASAR integrity is enabled` | **停止**；该构建可能拒绝修改后的归档，改用源码集成或官方合并 |
| `RunAsNode` 非 enabled | 可继续，但 watchdog 无法运行，启动失败观测降级 |
| 锚点不匹配 | **停止**；版本不兼容，不得强行应用 |
| 已打补丁 | 使用原始 `app.asar.bak-<时间戳>` 作为构建输入，见第 6.2 节 |

## 6. 生成补丁副本

### 6.1 未打补丁的安装

```powershell
New-Item -ItemType Directory -Force -Path "$env:TEMP\dsh-local" | Out-Null

node .\desktop-shell\patch\repack-asar.mjs `
  "<DSH_INSTALL>\resources\app.asar" `
  "$env:TEMP\dsh-local\app.patched.asar" `
  --report "$env:TEMP\dsh-local\report.json"
```

脚本会校验锚点、生成新的 ASAR 副本并写报告；不会修改安装目录。

### 6.2 已打补丁的安装

当前 `app.asar` 的 `main.js` 已含托盘代码，锚点会失败。必须用原始备份作为输入：

```powershell
node .\desktop-shell\patch\repack-asar.mjs `
  "<DSH_INSTALL>\resources\app.asar.bak-<时间戳>" `
  "$env:TEMP\dsh-local\app.patched.asar" `
  --report "$env:TEMP\dsh-local\report.json"
```

后续预检和应用必须加 `-SourceAsar "<原始备份>"`，使报告校验有效。没有原始备份时，
先恢复一份原始 DSH 安装，不得从已打补丁的 live 包重建。

## 7. 预检

```powershell
powershell -File .\desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\dsh-local\app.patched.asar" `
  -Report "$env:TEMP\dsh-local\report.json"
```

从原始备份构建时追加：

```powershell
  -SourceAsar "<DSH_INSTALL>\resources\app.asar.bak-<时间戳>"
```

预检不修改文件。必须确认：

- 输出包含 `Report verified`；
- 安装目录、补丁路径、备份路径正确；
- 运行中的 DSH 进程数符合预期；
- 输出以 `DRY RUN` 结尾。

## 8. 应用并重启

保持 DSH 运行即可；脚本会等待退出：

```powershell
powershell -File .\desktop-shell\patch\apply-after-exit.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\dsh-local\app.patched.asar" `
  -Report "$env:TEMP\dsh-local\report.json"
```

从原始备份构建时追加 `-SourceAsar "<备份>"`。

脚本执行：

1. 再次 dry-run 校验；
2. 等待所有 `DeepSeek Harness.exe` 退出（默认 300 秒）；
3. 备份当前 `app.asar`，暂存新包、校验哈希、原子替换；
4. 复制 `tray-restart-watchdog.cjs` 到 `resources\`；
5. 重新启动 DSH。

当前 DSH 窗口会关闭，几秒后重新打开。

## 9. 验证

### 9.1 托盘菜单

右键托盘应看到：

```text
打开 DeepSeek Harness
重启 DeepSeek Harness
──────────────
退出 DeepSeek Harness
```

中文系统显示“重启 DeepSeek Harness”；英文系统显示“Restart DeepSeek Harness”。

### 9.2 重启行为

1. 点击“重启 DeepSeek Harness”；
2. 确认旧窗口关闭、新窗口出现；
3. 确认新进程的 `ExecutablePath` 与旧进程一致；
4. 确认没有双实例提示或恢复框。

### 9.3 日志

```text
%APPDATA%\@deepseek-ai\dsh-desktop\tray-restart\
  restart.log          时间线：请求、快照、watchdog、退出、新 PID、残留清理
  last-result.json     最近一次结果：status、code、newPids、residualKilled
  startup.log          启动状态 RPC 重试记录
  host-stderr.log      Host stderr
  host-events.log      Host close 事件
```

正常结果：`last-result.json` 的 `status` 为 `ok`；`startup.log` 偶尔出现一行 `retrying`
属于预期重试。

## 10. 可选：`/restart-dsh` 命令

托盘功能不依赖该 bundle。需要命令时：

1. DSH → **设置 → 插件 → 添加插件**；
2. 选择绝对路径：`<工具包目录>\plugin\dsh-restart-command`；
3. 在命令面板执行 `/restart-dsh`。

未打壳补丁时命令返回“未安装托盘补丁”，不会杀进程。命令的详细规范见
[plugin/dsh-restart-command/docs/DETAIL.md](plugin/dsh-restart-command/docs/DETAIL.md)。

## 11. 回滚

应用脚本会打印备份路径。回滚前先完全退出 DSH：

```powershell
powershell -File .\desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -Rollback `
  -Backup "<DSH_INSTALL>\resources\app.asar.bak-<时间戳>"
```

watchdog 文件可以保留；未打补丁的桌面壳不会使用它。

## 12. 升级

DSH 桌面壳升级会覆盖 `app.asar`。升级后：

1. 重新运行 `doctor.ps1`；
2. 从新安装的原始 `app.asar` 重新生成补丁；
3. 预检、应用、验证；
4. 若锚点不匹配，停止并等待工具包适配，不得复用旧补丁。

## 13. 故障排查

| 现象 | 检查 |
|---|---|
| 托盘没有新增项 | 是否真正替换了 `app.asar`；`doctor` 是否显示已打补丁；桌面壳是否 Windows 分支 |
| 点击无反应 | `restart.log` 是否有 `restart requested`；是否处于退出流程 |
| 重启后旧进程残留 | `last-result.json` 的 `residualKilled`；`restart.log` 是否 `exit-timeout` |
| 新窗口未出现但有错误框 | receipt `code`：`spawn-error`、`start-failed`、`start-unstable` |
| 重启后仍弹恢复框 | `startup.log`、`host-stderr.log`、`host-events.log` |
| `/restart-dsh` 报未安装补丁 | Host 环境是否有 `DSH_DESKTOP_RESTART_IPC=1` |
| 更新后功能消失 | 预期；重新打补丁或等待官方合并 |

故障排查表见本节；日志位置见第 9.3 节。

## 14. 禁止事项

- 不得分发 `app.asar`、`app.asar.bak-*`、DeepSeek Harness 安装包或本地补丁副本；
- 不得用 DeepSeek 名称/Logo/签名冒充官方安装包；
- 不得在版本不匹配或 `doctor.ps1` 未通过时强行应用；
- 不得在 DSH 内置终端运行 `-Apply` / `apply-after-exit.ps1`；
- 不得删除原始备份，直到确认新版本稳定；
- 不得自动提权或绕过 UAC 执行应用步骤。
