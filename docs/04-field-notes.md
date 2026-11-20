# 现场记录：首次托盘重启后的 `fetch failed`（v2 已修复并现场验证）

> v3 起托盘菜单文案为“重启 DeepSeek Harness”；本文早期记录中的“重启 DSH”是当时文案。

记录一次真实操作（2026-11-19，Asia/Shanghai），用于区分“重启事务失败”和“新实例启动后的应用层错误”。

## 时间线

| 本地时间 | UTC | 事件 |
|---|---|---|
| 17:45:48.715 | 09:45:48.715 | 点击托盘“重启 DSH”；旧 shell PID 19804 |
| 17:45:48.751 | 09:45:48.751 | `app.relaunch()` 已调度，准备退出 |
| 17:45:48.765 | 09:45:48.765 | 看门狗 PID 26236 启动 |
| 17:45:52.067 | 09:45:52.067 | 看门狗捕获旧进程树（仅 19804，Host/渲染器已先退出） |
| 17:45:52.068 | 09:45:52.068 | 旧主进程退出 |
| 17:45:53.718 | 09:45:53.718 | 观察到新实例进程：6524, 14140, 8336, 7020, 23516 |
| 17:45:56.224 | 09:45:56.224 | 2.5s 稳定期通过；无旧树残留；receipt `status: ok` |
| **17:46:06.199** | **09:46:06.199** | 新 shell（PID 6524）写入 `crash-...-main.log`：`fetch failed` / `ECONNRESET`，source `main`，phase `running` |
| ~17:46:20 | — | 用户点击 DSH 崩溃恢复对话框中的“重启” |
| 17:46:23 | — | 恢复重启成功；当前 shell PID 26868，Host 20140 |

## 证据

### 看门狗成功（`%APPDATA%\@deepseek-ai\dsh-desktop\tray-restart\restart.log`）

```text
17:45:48.715 restart requested (pid=19804, exe=D:\Soft\DSH\DeepSeek Harness.exe, args=[])
17:45:48.751 app.relaunch() scheduled; quitting
17:45:48.765 watchdog started pid=26236
17:45:52.068 [watchdog] old process exited
17:45:53.718 [watchdog] new instance observed: pids=6524,14140,8336,7020,23516
17:45:56.224 [watchdog] new instance healthy: pids=6524,14140,8336,7020,23516
17:45:56.225 [watchdog] no residual old-tree processes
17:45:56.228 [watchdog] restart completed successfully
```

`last-result.json`：`status: ok`，`residualKilled: []`。

### 崩溃报告（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-11-19T09-46-06-199Z-main.log`）

```text
time: 2026-11-19T09:46:06.199Z
source: main
phase: running
app: @deepseek-ai/dsh-desktop 0.2.2-rc.5
shell pid: 6524

--- error ---
[TypeError: fetch failed] {
  [cause]: Error: read ECONNRESET
      at TCP.onStreamRead ...
      code: 'ECONNRESET'
}
```

- 只有这一份 crash report；恢复重启后没有新的 report。
- Windows 应用程序日志在 09:45–09:47 没有 `DeepSeek Harness.exe` 的 Application Error 事件。
- 失败实例的 5 个 PID（含 shell 6524）当前均已退出；当前实例为 17:46:23 启动的 26868/20140。
- 当前 `app.asar` 已是补丁版（`bc1f30d7…f83f9`），watchdog 存在。

## 判断

1. **托盘重启事务成功**：旧主进程退出、新进程启动、无旧树残留；看门狗的职责（进程是否起来）已完成。
2. **失败发生在新实例启动约 10 秒后**：shell 已存活，正在读取启动状态；错误是主进程的一次 `fetch` 连接被对端重置，不是退出超时、权限不足或 ASAR 读失败。
3. **最可能的调用点**：`openInitialWindow()` → `readWelcomeState()` → `connectDesktopWelcome` 对本机 Host 的 RPC `fetch`。`openInitialWindow` 的拒绝会被 `reportFatal(error, "main")` 捕获，与 crash report 的 `source: main`、`phase: running` 吻合。
4. **最可能的原因**：本机 Host 的 HTTP keep-alive 连接在启动忙期被服务端关闭（默认 5s 空闲超时），shell 在约 10s 后复用该连接发起 RPC，收到 `ECONNRESET`；DSH 的该 RPC 没有重试，于是进入致命恢复对话框。也可能是 Host 在启动期短暂重置/退出，但当前没有 Host stderr 可证实。
5. **不是补丁逻辑导致**：补丁只改托盘菜单、重启编排和 `restart-app` IPC；没有改 `fetch`、`openInitialWindow`、`welcomeBackend`、Host 启动。重启路径与 DSH 自带的恢复重启使用同一个 `app.relaunch()` + `quitWithoutConfirmation()`；恢复重启成功说明 relaunch/退出链本身可靠。
6. **看门狗无法捕获它**：看门狗校验“新进程是否存在且 2.5s 内不退出”；这次新 shell 一直存活并弹出了 DSH 自己的恢复对话框。应用层 readiness 不在进程看门狗的判定范围内。

## 第二次复现（17:58）

用户再次点击托盘“重启 DSH”，得到**完全相同**的结果：

| 本地时间 | 事件 |
|---|---|
| 17:58:31.539 | 第二次点击；旧 shell PID **26868** |
| 17:58:31.590 | 看门狗 PID 7172 |
| 17:58:34.742 | 旧主进程退出 |
| 17:58:36.334 | 新实例进程：`26352, 19616, 26660, 16196, 12944` |
| 17:58:38.839 | 看门狗判定 healthy，无残留 |
| **17:58:49.073** | 新 shell（PID **26352**）再次 `fetch failed` / `ECONNRESET` |
| 17:58:52 | 恢复重启成功；当前 shell 23348，Host 18692 |

第二次 crash report 与第一次同为 `source: main`、`phase: running`，时间差同样是**新进程出现后约 12.7 秒**。
这说明不是一次性网络抖动，而是可复现的启动竞态：Host 启动完成、shell 读取启动状态时，复用的本机连接被重置。
两次都是“健康实例的托盘重启”失败，而“失败实例的恢复重启”成功；但恢复重启也使用同一套
`app.relaunch()` + `quitWithoutConfirmation()`，因此差异更可能在 Host/连接时序，而不是退出链。

## 建议与 v2 硬化

v2 补丁已实施三项**针对性**修改（不改退出链、认证协议、Host 启动参数或插件 Loader）：

1. **启动状态读取重试**：`openInitialWindow()` 改用 `readWelcomeStateWithRetry()`，对
   `ECONNRESET`/`ECONNREFUSED`/`EPIPE`/`fetch failed` 等瞬时错误重试最多 3 次（间隔 300/600ms）；
   仍失败才进入 DSH 自带恢复对话框。重试记录写入 `tray-restart/startup.log`。
2. **Host stderr 落盘**：`DesktopHostProcess` 的 stderr 追加写入 `tray-restart/host-stderr.log`。
3. **Host 退出事件落盘**：close 时记录退出码和 stderr 尾部到 `tray-restart/host-events.log`。

如果重试后不再弹窗，问题解决；如果仍弹窗，这三个日志可以回答“Host 是否真的退出、退出码是什么、
stderr 说了什么”，再决定是否用恢复对话框的“禁用第三方插件”排除插件。

v2 产物（从原始安装备份 `app.asar.bak-20261119-174449` 生成）：

| 项 | 值 |
|---|---|
| `lib/main.js` | 848,505 → 854,299 字节 |
| `mainPatchedSha256` | `11c2d41873506bd08491164993818bc2b19f606ebb6ceab6c5865206bdf367c6` |
| 输出 archive SHA-256 | `807f4eb35fa413788cd7b07b7dd23de31be24a4db7ca86f1d33c3c43a899044b` |

应用时因为当前 live 已经是 v1 补丁包，需要显式指定来源备份，让 report 校验仍然有效：

```powershell
powershell -File desktop-shell\patch\apply-after-exit.ps1 `
  -InstallDir "D:\Soft\DSH" `
  -PatchedAsar "$env:TEMP\dsh-hardened\app.patched.asar" `
  -Report "$env:TEMP\dsh-hardened\report.json" `
  -SourceAsar "D:\Soft\DSH\resources\app.asar.bak-20261119-174449"
```

然后退出 DSH；脚本应用并重启。之后点击托盘重启验证：

- 不再弹框：v2 生效；
- 仍弹框：不要急着点重启，先复制
  `%APPDATA%\@deepseek-ai\dsh-desktop\tray-restart\startup.log`、`host-stderr.log`、`host-events.log`，
  再点恢复框“重启”。这三份日志会给出 Host 是否退出及原因。

看门狗可选的增强（本次未做）：把稳定期从 2.5s 延长到 10–15s，只能多覆盖“进程早退”，无法覆盖
“进程存活但启动状态读取失败”；真正的修复点在 shell 的启动 RPC 重试。

## v2 现场验证（18:11–18:13）

- 18:10:25 应用 v2；live `app.asar` = `807f4eb3…044b`，watchdog 存在。
- 18:11:04 托盘重启成功；18:12:31 再次托盘重启成功。两次 watchdog 回执均 `status: ok`、无残留。
- `tray-restart/startup.log` 捕获到与旧故障完全相同的时刻和错误：

  ```text
  2026-11-19T10:12:49.550Z welcome-state read failed (attempt 1): fetch failed ECONNRESET; retrying
  ```

  这是 18:12:36 新实例的第一次 `readWelcomeState()`；v2 重试后成功，应用正常打开。
- 应用 v2 后 **没有新增 crash report**（仍只有 17:46、17:58 两份旧报告）。
- `host-events.log` 只有 `host close code=0` 的优雅退出；`host-stderr.log` 只有模型列表日志，无 Host 错误/崩溃。
- 用户确认：不再弹恢复框，可以直接启动。

结论：

- 旧故障的根因是 **Host 就绪后首次欢迎状态 RPC 的连接重置**，不是 Host 崩溃（close code 0）或退出链问题；
- v2 的启动重试在该时刻接住了 `ECONNRESET`，Host 保持存活，窗口正常打开；
- 该修复已现场验证有效。偶尔在 `startup.log` 看到一行 `retrying` 属于预期，不需要处理；若重试 3 次后仍失败，才会进入 DSH 恢复框，此时用 `host-stderr.log` / `host-events.log` 继续定位。

## v3：仅调整菜单文案

2026-11-19 18:17 从同一原始备份构建 v3，唯一变化是把托盘项从“重启 DSH”改为
“重启 DeepSeek Harness”（英文 “Restart DeepSeek Harness”）；v2 的启动重试与 Host 日志不变。

| 项 | 值 |
|---|---|
| `lib/main.js` | 854,312 字节 |
| `mainPatchedSha256` | `677adcf6047b1842b0684f95175e008fdee02c2d084a9112b08c7df98cbbc1d2` |
| 输出 archive SHA-256 | `592987efc8e2162b2383f2b09462f1d70b03e217a9014737cf4933f243dce568` |

已验证新 main.js 包含 `messages.restartApplication} DeepSeek Harness`，不再包含旧的
`messages.restartApplication} DSH`；ASAR 回读哈希一致。

