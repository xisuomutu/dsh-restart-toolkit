# 进程退出与重启逻辑

## 1. 触发入口

```
托盘右键 “重启 DeepSeek Harness”
        │
        ▼
restartFromTray()                         [Electron 主进程]
  1. trayRestartInFlight / quitting / shuttingDown 守卫（幂等）
  2. 写启动快照 & restart.log
  3. spawn 看门狗（detached, ELECTRON_RUN_AS_NODE=1）
  4. app.relaunch()                       ← 与原实例相同的 exe + argv
  5. quitWithoutConfirmation()            ← 进入桌面壳原有退出链
```

对应实现：

- 源码构建版：`desktop-shell/src/tray-restart.js` 的 `createTrayRestart()`；
- 已安装 bundle 版：`desktop-shell/patch/main.js.patch` 中 `main()` 内的 `restartFromTray()`；
- 看门狗：`desktop-shell/runtime/tray-restart-watchdog.cjs`。

为什么先起看门狗再退出：`app.relaunch()` 没有完成回调，壳退出后也无法再弹 UI。看门狗必须在壳还活着时
被拉起，才能观察到“旧进程已退出但新进程没起来”的窗口。

## 2. 桌面壳退出链（需求 2 的核心）

`quitWithoutConfirmation()` 只是设置 `skipQuitConfirmation` 并 `app.quit()`。真正的清理在
`main.js` 的 `before-quit` → `finishQuit()` 中：

| 步骤 | 代码 | 行为 |
|---|---|---|
| 1 | `finishQuit()` | `quitting = true; shuttingDown = true`，销毁托盘，隐藏窗口，停止更新/策略/账号订阅 |
| 2 | `backend.close()` | 向 Host 发送 `{type:"shutdown"}` |
| 3 | `DesktopHostProcess.stop()` | 等待 Host 优雅退出 **10s** |
| 4 | 仍不退出 | `child.kill("SIGTERM")`，再等 **5s** |
| 5 | 仍不退出 | `child.kill("SIGKILL")`，再等 **5s**；仍不退则抛错 |
| 6 | 清理完成 | `app.quit()`，Electron 关闭渲染器/GPU/utility，处理 `app.relaunch()` 队列 |

Host 收到 `shutdown` 后执行 `application.shutdown.shutdown(0)`，Cordis 插件 dispose：终端、MCP、
子代理、后台作业等由各自插件清理。因此正常路径**不需要 `taskkill`**，也不会绕过任何插件的清理逻辑。

看门狗的超时（30s）故意大于壳自身的最坏退出时间（10+5+5=20s），正常路径下它只会看到旧进程退出并等待
新进程出现。

## 3. 看门狗状态机

配置示例（`%APPDATA%\@deepseek-ai\dsh-desktop\tray-restart\restart-<ts>.json`）：

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

> 快照**不包含环境变量**。看门狗从壳继承环境；启动 GUI 前删除 `ELECTRON_RUN_AS_NODE` 等变量，
> 防止把 GUI 当 Node 进程启动，同时避免把凭据写入磁盘。

状态转移：

```
ARMED
  │ 记录日志；捕获旧主进程的完整后代 PID 集合（用于定向残留清理）
  ▼
WAIT_OLD_EXIT ──(≤30s 退出)──► WAIT_NEW_INSTANCE
  │ 超时
  ▼
FORCE_KILL（按 PID 从叶到根逐级 taskkill /F，绝不使用 /T）──(≤8s 退出)──► WAIT_NEW_INSTANCE
  │ 仍不退出
  ▼
FAIL exit-timeout（消息框 + receipt，不启动新实例，避免双实例）

WAIT_NEW_INSTANCE ──(发现同 exe、创建时间 > cutoff 的进程)──► SETTLE
  │ 25s 内没有
  ▼
FALLBACK_START（用快照 execPath/argv/cwd 自行启动）──► SETTLE

SETTLE（2.5s）──(进程仍存活)──► CLEANUP_RESIDUAL ──► SUCCESS（receipt, exit 0）
  │ 进程消失
  ▼
FAIL start-unstable / start-failed（消息框 + receipt, exit 1）
```

关键实现点：

- **旧进程存活检测**：`process.kill(pid, 0)`；`EPERM` 视为存活。PID 复用窗口很短，且后面还有
  创建时间与进程树校验。
- **新进程发现**：`Get-CimInstance Win32_Process` 过滤 `ExecutablePath == 快照 exe` 且
  `CreationDate > cutoff`，排除看门狗自身。开发模式下 exe 是 `electron.exe`，用路径而不是进程名
  避免误匹配其它 Electron 应用。
- **启动兜底**：`spawn(exe, args, { cwd, env: cleanedEnv, detached: true, stdio: "ignore" })`。
  若 `app.relaunch()` 已经启动新实例，兜底启动会因 Electron 单实例锁立即退出；看门狗以“至少有一个
  新进程存活”为准，不把第二个进程的退出当失败。
- **残留清理**：只清理**启动前捕获的旧主进程后代 PID**，而不是“所有更老的同 exe 进程”。后者会误杀
  另一个 DSH 实例（测试环境里甚至会误杀测试进程）。捕获失败时跳过清理并记日志。
- **强制清理不自杀**：看门狗本身就是旧主进程的子进程，`taskkill /T` 会把看门狗一起杀掉。因此强制路径
  先枚举旧主进程的后代（排除看门狗子树），再**按 PID 从叶到根**执行 `taskkill /F`（不带 `/T`）；
  同时跳过 `conhost.exe` / `OpenConsole.exe` / `WindowsTerminal.exe`——杀控制台宿主会连带杀死共享
  控制台的看门狗。看门狗由壳以 `detached: true` 启动，并在测试中专门覆盖了“旧树包含看门狗”的场景。
- **启动稳定期**：新进程出现后等待 `settleMs`，再次确认存活；避免“刚起来就崩”被误判成功。
- **硬超时**：看门狗自身 180s 硬截止，防止 PowerShell/CIM 卡死导致看门狗永久驻留。

## 4. 异常矩阵

| 场景 | 检测点 | 行为 | 用户可见结果 |
|---|---|---|---|
| 退出超时（Host 不响应 shutdown） | 壳 `stop()` 10s/5s/5s；看门狗 30s | 壳先 SIGTERM/SIGKILL Host；看门狗再按 PID 逐级 `taskkill /F` 旧主进程后代（不用 `/T`，不杀自己和 conhost） | 正常重启；日志记录升级路径 |
| 强制终止后旧进程仍存活 | `WAIT_OLD_EXIT` 两次超时 | 不启动新实例；receipt `exit-timeout` | 错误框：原因、exe、日志路径、建议手动启动/管理员 |
| `app.relaunch()` 未生效 | 25s 内无新进程 | 用快照自行启动 | 正常重启（日志标记 fallback） |
| 启动即退出（单实例/资源缺失/崩溃） | `SETTLE` 后无存活进程 | receipt `start-unstable`；不无限重试 | 错误框 + 日志 |
| 新进程存活，但应用层启动状态读取失败 | DSH 自身 `reportFatal`（如 `openInitialWindow` 的 Host RPC 连接重置） | **不归看门狗**：进程仍在，DSH 弹出自带恢复对话框；点“重启”走同一 `app.relaunch` 路径重试 | DSH 恢复对话框 + 日志；现场记录见 [04-field-notes.md](04-field-notes.md) |
| 可执行文件缺失/路径不可用 | 启动前 `existsSync`；spawn 错误 | receipt `watchdog-error` / `start-failed` | 错误框 |
| 权限不足（EACCES/EPERM） | `spawn` error 文本分类 | 不自动提权（避免意外 UAC）；receipt `spawn-error` | 错误框提示“以管理员身份运行或检查路径” |
| 看门狗不存在/启动失败 | 壳侧 `existsSync`/`spawn` error | 仍执行 `app.relaunch()` + 退出；仅失去启动失败观测 | 正常重启；日志记录降级 |
| 连点两次 | `trayRestartInFlight` | 第二次直接返回 | 无重复重启 |
| 退出过程中再次触发 | `quitting` / `shuttingDown` | 拒绝 | 无操作 |
| 权限不足安装/更新壳 | 非本功能运行时问题 | 文档说明需管理员/签名/更新策略 | — |

## 5. 日志与回执

默认位置（`app.getPath("userData")` 在 Windows 通常是 `%APPDATA%\@deepseek-ai\dsh-desktop`）：

```
tray-restart/
  restart.log          追加式时间线：请求、快照、看门狗 PID、relaunch、退出、新 PID、残留清理
  restart-<ts>.json    本次启动快照（不含环境变量）
  last-result.json     最近一次结果：status ok/failed、code、newPids、residualKilled、logPath
```

看门狗失败时还会走 Windows 消息框（`System.Windows.Forms.MessageBox`），内容包含原因、可执行文件、
日志路径和“手动启动/管理员”建议。`testMode: true` 时抑制消息框，供自动化测试使用。

## 6. 权限与提权

- 看门狗由桌面壳以**同一用户令牌**启动；如果 DSH 本身以管理员运行，看门狗也有管理员权限，可以正常
  重启。
- 如果 DSH 以普通用户运行，但目标 exe 被 ACL 限制，`spawn` 返回 `EACCES/EPERM`：不自动弹 UAC，
  而是提示用户以管理员身份启动 DSH 或修复路径权限。自动 `Start-Process -Verb RunAs` 会让“一键重启”
  突然变成 UAC 弹窗，且提权后的实例与原实例令牌不同，因此本实现不默认这样做。
- 给已安装应用打补丁、重打包 `app.asar` 通常需要管理员权限；这属于部署步骤，不是运行时逻辑。

## 7. 数据与任务

重启会中断正在生成的回合、工具调用、终端和后台作业；DSH 的会话日志按事件持久化，重启后会话可继续。
托盘项按“一键”语义不弹确认框。若需要“有运行中任务时先确认”，可在 `restartFromTray()` 里调用
`backend.host?.inspectQuit()`（桌面壳已有该接口，返回 `activeTasks`/`scheduledTasks`）后再决定是否继续；
本实现没有加，以保持一键操作和与开发菜单“重启应用与 Host”一致的行为。
