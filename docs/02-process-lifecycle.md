# 进程生命周期与重启规范

> 文档状态：已发布  
> 适用范围：DSH Desktop 0.2.2-rc.5（Windows）  
> 工具包版本：1.0.0  
> 相关文档：[架构设计](01-architecture.md) · [测试计划](03-test-plan.md)

## 1. 目的与范围

本文定义“重启 DeepSeek Harness”的触发条件、退出时序、watchdog 状态机、超时与失败处理、
日志规范和权限模型。目标是让实现、测试和运维对同一套行为有一致预期。

本文不重复架构取舍，见 [01-architecture.md](01-architecture.md)。

## 2. 术语

| 术语 | 含义 |
|---|---|
| 桌面壳 / shell | `DeepSeek Harness.exe` 的 Electron 主进程 |
| Host | `@deepseek-ai/dsh-desktop-host` 子进程，运行 Cordis Loader |
| 旧实例 | 点击重启时正在运行的桌面壳及其后代进程 |
| 新实例 | `app.relaunch()` 或 watchdog 兜底启动后的桌面壳 |
| 回执 / receipt | `last-result.json`，记录最近一次重启结果 |
| 强制清理 | 按 PID 从叶子到根执行 `taskkill /F`，不使用 `/T` |

## 3. 触发与前置条件

### 3.1 触发入口

| 入口 | 路径 |
|---|---|
| 托盘菜单 | `重启 DeepSeek Harness` → `restartFromTray()` |
| 可选命令 | `/restart-dsh` → `restart-app` IPC → `restartFromTray()` |

### 3.2 前置条件

- 运行在 Windows Desktop 配置；
- 桌面壳已应用补丁，`trayMenuTemplate` 与 `restartFromTray()` 存在；
- watchdog 文件位于 `resources/tray-restart-watchdog.cjs`（缺失时降级，见 7.3）；
- 当前不处于 `quitting` / `shuttingDown` 状态。

### 3.3 幂等与并发

`restartFromTray()` 使用 `trayRestartInFlight` 单飞标志：

- 第一次请求设置标志并继续；
- 进行中或退出中的第二次请求直接返回，不重复 `relaunch`；
- 失败时清除标志，允许用户重试。

## 4. 重启时序

```text
托盘 / /restart-dsh
        │
        ▼
restartFromTray()                         [Electron 主进程]
  1. 检查 trayRestartInFlight / quitting / shuttingDown
  2. 写启动快照与 restart.log
  3. spawn watchdog（detached, ELECTRON_RUN_AS_NODE=1）
  4. app.relaunch()                       使用当前 exe + argv
  5. quitWithoutConfirmation()            进入桌面壳退出链
        │
        ▼
finishQuit() → backend.close() → DesktopHostProcess.stop()
        │
        ▼
旧主进程退出 ──► watchdog 观测新实例 ──► 稳定期校验 ──► 回执
```

先启动 watchdog、再退出壳的原因：`app.relaunch()` 没有完成回调，壳退出后无法再弹 UI；
watchdog 必须在壳仍存活时被拉起，才能覆盖“旧进程已退出但新进程未启动”的窗口。

## 5. 桌面壳退出链

`quitWithoutConfirmation()` 只设置 `skipQuitConfirmation` 并调用 `app.quit()`；实际清理发生在
`before-quit` → `finishQuit()`。

| 步骤 | 机制 | 行为 |
|---|---|---|
| 1 | `finishQuit()` | 设置 `quitting` / `shuttingDown`，销毁托盘、隐藏窗口、停止更新/策略/账号订阅 |
| 2 | `backend.close()` | 向 Host 发送 `{ type: "shutdown" }` |
| 3 | `DesktopHostProcess.stop()` | 等待 Host 优雅退出 **10s** |
| 4 | 超时 | `SIGTERM`，再等 **5s** |
| 5 | 仍超时 | `SIGKILL`，再等 **5s**；仍不退则抛错 |
| 6 | 清理完成 | `app.quit()`，Electron 关闭渲染器/GPU/utility，并处理 `app.relaunch()` 队列 |

Host 收到 `shutdown` 后执行 `application.shutdown.shutdown(0)`，Cordis 插件依次 dispose；
终端、MCP、子代理和后台作业由各自插件清理。正常路径**不需要 `taskkill`**，也不会绕过插件清理。

## 6. watchdog 状态机

### 6.1 配置快照

watchdog 启动时读取 `tray-restart/restart-<ts>.json`：

```json
{
  "version": 1,
  "oldPid": 12345,
  "cutoff": 1700000000000,
  "executablePath": "D:\\Soft\\DSH\\DeepSeek Harness.exe",
  "args": [],
  "cwd": "D:\\Soft\\DSH",
  "logPath": "...\\tray-restart\\restart.log",
  "receiptPath": "...\\tray-restart\\last-result.json",
  "timeouts": { "exitMs": 30000, "forceMs": 8000, "startMs": 25000, "settleMs": 2500 }
}
```

快照**不包含环境变量**。watchdog 从桌面壳继承环境，并在启动 GUI 前移除
`ELECTRON_RUN_AS_NODE` 等变量，防止把 GUI 当作 Node 进程启动，也避免凭据落盘。

### 6.2 状态转移

```text
ARMED
  │ 记录日志；捕获旧主进程的完整后代 PID 集合
  ▼
WAIT_OLD_EXIT ──(≤30s 退出)──► WAIT_NEW_INSTANCE
  │ 超时
  ▼
FORCE_KILL（按 PID 从叶到根 taskkill /F，不使用 /T）──(≤8s 退出)──► WAIT_NEW_INSTANCE
  │ 仍不退出
  ▼
FAIL exit-timeout（消息框 + receipt；不启动新实例，避免双实例）

WAIT_NEW_INSTANCE ──(发现同 exe、创建时间 > cutoff 的进程)──► SETTLE
  │ 25s 内没有
  ▼
FALLBACK_START（用快照 execPath/argv/cwd 启动）──► SETTLE

SETTLE（2.5s）──(进程仍存活)──► CLEANUP_RESIDUAL ──► SUCCESS（receipt, exit 0）
  │ 进程消失
  ▼
FAIL start-unstable / start-failed（消息框 + receipt, exit 1）
```

### 6.3 实现约束

| 约束 | 说明 |
|---|---|
| 旧进程存活检测 | `process.kill(pid, 0)`；`EPERM` 视为存活；后续再用创建时间/进程树校验 |
| 新进程发现 | `Get-CimInstance Win32_Process` 过滤 `ExecutablePath == 快照 exe` 且 `CreationDate > cutoff`，排除 watchdog 自身 |
| 启动兜底 | `spawn(exe, args, { cwd, env: cleanedEnv, detached: true, stdio: "ignore" })`；若单实例锁已生效，第二个进程会立即退出，不视为失败 |
| 残留清理 | 只清理启动前捕获的旧主进程后代 PID，不清理“所有更老的同 exe 进程” |
| 不自伤 | watchdog 是旧主进程子进程；强制清理按 PID 逐级执行，不使用 `/T`，并跳过 `conhost.exe` / `OpenConsole.exe` / `WindowsTerminal.exe` |
| 稳定期 | 新进程出现后等待 2.5s，再次确认存活，避免“刚起来就崩”被误判成功 |
| 硬截止 | watchdog 自身 180s 上限，防止 PowerShell/CIM 卡死导致永久驻留 |

## 7. 超时与失败处理

### 7.1 异常矩阵

| 场景 | 检测点 | 行为 | 用户可见结果 |
|---|---|---|---|
| Host 不响应 shutdown | 壳 10s/5s/5s；watchdog 30s | 壳先 SIGTERM/SIGKILL；watchdog 再按 PID 清理旧树 | 正常重启；日志记录升级路径 |
| 强制终止后旧进程仍存活 | `WAIT_OLD_EXIT` 两次超时 | 不启动新实例；receipt `exit-timeout` | 错误框：原因、exe、日志路径、手动启动/管理员建议 |
| `app.relaunch()` 未生效 | 25s 无新进程 | 用快照兜底启动 | 正常重启（日志标记 fallback） |
| 启动即退出 | `SETTLE` 后无存活进程 | receipt `start-unstable`；不无限重试 | 错误框 + 日志 |
| 新进程存活但应用层就绪失败 | DSH 自身 `reportFatal` | watchdog 不介入；DSH 弹恢复框，点“重启”走同一 `relaunch` 路径 | DSH 恢复框 + 日志 |
| 可执行文件缺失/不可用 | 启动前 `existsSync`；spawn 错误 | receipt `watchdog-error` / `start-failed` | 错误框 |
| 权限不足 | `spawn` 返回 `EACCES/EPERM` | 不自动提权；receipt `spawn-error` | 错误框提示管理员/路径 |
| watchdog 缺失/启动失败 | 壳侧 `existsSync` / spawn error | 仍执行 `relaunch` + 退出；仅失去启动失败观测 | 正常重启；日志记录降级 |
| 连点 | `trayRestartInFlight` | 第二次直接返回 | 无重复重启 |
| 退出中再次触发 | `quitting` / `shuttingDown` | 拒绝 | 无操作 |

### 7.2 失败分类

| 类别 | receipt `code` | 处理 |
|---|---|---|
| 退出超时 | `exit-timeout` | 强制清理失败；不启动第二实例 |
| 启动失败 | `start-failed` / `spawn-error` | 弹框；不无限重试 |
| 启动不稳定 | `start-unstable` | 弹框；保留日志 |
| watchdog 自身错误 | `watchdog-error` | 弹框；记录堆栈/路径 |

### 7.3 降级行为

watchdog 不存在或无法启动时，桌面壳仍执行 `app.relaunch()` + 退出，托盘功能可用；
但“新进程未启动/启动即崩”不再有独立观测和提示。此时以 `restart.log` 中的
`watchdog missing` / `watchdog spawn failed` 为准。

## 8. 日志与回执

默认目录：`%APPDATA%\@deepseek-ai\dsh-desktop\tray-restart\`

| 文件 | 内容 | 保留策略 |
|---|---|---|
| `restart.log` | 追加式时间线：请求、快照、watchdog PID、relaunch、退出、新 PID、残留清理 | 持续追加 |
| `restart-<ts>.json` | 本次启动快照，不含环境变量 | 每次重启一份 |
| `last-result.json` | 最近结果：`status`、`code`、`newPids`、`residualKilled`、`logPath` | 覆盖写 |
| `startup.log` | 欢迎状态 RPC 重试记录 | 追加 |
| `host-stderr.log` | Host stderr | 追加 |
| `host-events.log` | Host close 事件（退出码 + stderr 尾部） | 追加 |

watchdog 失败时通过 Windows 消息框提示原因、可执行文件、日志路径和“手动启动/管理员”
建议；`testMode: true` 时抑制消息框，供自动化测试使用。

## 9. 权限模型

- watchdog 由桌面壳以**同一用户令牌**启动；DSH 以管理员运行时，watchdog 也具备管理员权限。
- DSH 以普通用户运行但目标 exe 被 ACL 限制时，`spawn` 返回 `EACCES/EPERM`；实现**不自动提权**，
  避免一键重启突然弹 UAC，也避免提权后实例令牌不一致。
- 替换 `app.asar`、重打包属于部署步骤，通常需要安装目录写权限或管理员权限。

## 10. 数据一致性与任务中断

- 重启会中断正在生成的回合、工具调用、终端和后台作业。
- DSH 会话日志按事件持久化；重启后可继续会话，但进行中的工作不会恢复。
- 托盘项按“一键”语义不弹确认框。若需要“有运行中任务时确认”，可在 `restartFromTray()` 中
  调用 `backend.host?.inspectQuit()`（返回 `activeTasks` / `scheduledTasks`）后再决定；
  当前实现未加入，以保持与开发菜单“重启应用与 Host”一致的行为。
- 快照不写环境变量；日志不记录 token、API key 或完整环境。

## 11. 相关文档

- [架构设计](01-architecture.md)
- [测试计划](03-test-plan.md)
- [安装指南](../INSTALL.md)
