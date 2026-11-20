# 测试要点与验收矩阵

## 0. 环境

- Windows 11（本机 26300），DSH Desktop 0.2.2-rc.5；默认 `%APPDATA%\@deepseek-ai\dsh-desktop`。
- 自动化测试只依赖 Node（本机 v26）与 Windows PowerShell 5.1；不联网、不下载依赖。
- 手工测试需要可应用壳补丁的构建/副本；直接改正在运行的安装会终止当前会话。

## 1. 自动化测试（已执行）

```powershell
cd <工具包目录>
node --test desktop-shell/test/tray-restart.test.mjs
node --test desktop-shell/test/watchdog.test.mjs
node --test plugin/dsh-restart-command/test/command.test.mjs
```

覆盖点：

| 文件 | 用例 |
|---|---|
| `tray-restart.test.mjs` | 菜单只新增一项、原 Open/Quit label 与顺序不变；点击回调正确；单飞；退出中拒绝；`relaunch` 抛错不退出、弹框、解除单飞；看门狗缺失仍重启；看门狗 spawn 失败仍重启；`quit` 抛错；快照不含环境变量 |
| `watchdog.test.mjs` | 旧进程退出但无 relaunch → 兜底启动成功；旧进程超时 → 逐 PID 强制终止后成功；不可执行文件 → receipt `failed` + exit 1；**看门狗是旧主子进程时，强制清理旧树不会自杀**（`detached` + 逐 PID、不用 `/T`、排除 conhost） |
| `command.test.mjs` | `/restart-dsh` 发送 `restart-app`；`--help` 不发送；缺少壳补丁返回明确错误；IPC 失败返回错误 |

预期结果：`9 + 4 + 4 = 17 passed`。

## 2. 补丁校验（已执行）

```powershell
# 1) 从 ASAR 复制出 lib/main.js（只读复制，不改 app.asar）
# 2) 只读校验锚点、替换次数、语法
node desktop-shell/patch/check-patch.mjs <path-to>\main.js

# 3) 在临时目录验证补丁可应用，且结果与 builder 输出逐字节一致
mkdir <tmp>\lib
copy <path-to>\main.js <tmp>\lib\main.js
cd <tmp>
git -c core.autocrlf=false apply --check --whitespace=nowarn <repo>\desktop-shell\patch\main.js.patch
git -c core.autocrlf=false apply --whitespace=nowarn <repo>\desktop-shell\patch\main.js.patch
# 与 main.patched.js 比较 SHA-256
```

验收点：

- `check-patch.mjs` 输出 `all anchors matched once`；
- `git apply --check` 退出码 0；
- 应用后的 `lib/main.js` 与 `build-patch.mjs` 生成的 `main.patched.js` SHA-256 相同；
- `node --check main.patched.js` 退出码 0。

> 注意：`git apply` 必须加 `-c core.autocrlf=false`。否则 Git 会把 LF 转成 CRLF，文件内容不再与
> 原 ASAR 中的 LF 文件一致。

## 2.1 附加式 ASAR 副本验证（已执行）

```powershell
node desktop-shell/patch/repack-asar.mjs `
  "D:\Soft\DSH\resources\app.asar" `
  "$env:TEMP\app.patched.asar" `
  --report "$env:TEMP\report.json"
```

本机结果：

| 项 | 值 |
|---|---|
| `lib/main.js` | 848,505 → 854,312 字节（v3：菜单文案 + 启动重试 + Host 日志） |
| main.js offset | 201,569,178 → 203,411,600（追加到末尾） |
| 头部 JSON | 5,671,182 / 5,671,389 字节（原槽位填充） |
| data start | 5,671,408（不变） |
| 归档大小 | 209,083,008 → 209,937,320 |
| 自校验 | main.js 回读哈希一致；`lib/preload-app.cjs` 未改文件字节一致 |
| `mainPatchedSha256` | `677adcf6047b1842b0684f95175e008fdee02c2d084a9112b08c7df98cbbc1d2` |
| 输出 archive SHA-256 | `592987efc8e2162b2383f2b09462f1d70b03e217a9014737cf4933f243dce568` |

独立读取验证：用安装自带的 Electron 以 `ELECTRON_RUN_AS_NODE=1` 读取
`app.patched.asar/lib/main.js`，返回 854,312 字节、哈希与 `main.patched.js` 一致；
`package.json` 解析为 `@deepseek-ai/dsh-desktop`，`lib` 目录可正常列举。

完整可复现命令（构建 → 校验报告 → Electron 回读 → 部署 dry-run；不改安装）：

```powershell
# live 仍是原包时
powershell -File tests/verify-asar-patch.ps1 -InstallDir "D:\Soft\DSH"

# live 已打过 v1/v2、需要从原始备份重新构建时
powershell -File tests/verify-asar-patch.ps1 `
  -SourceAsar "D:\Soft\DSH\resources\app.asar.bak-20261119-174449" `
  -InstallDir "D:\Soft\DSH"
# PASS: append-only ASAR patch is valid and matches the source archive.
```

部署 dry-run（未改文件）：

```powershell
powershell -File desktop-shell/patch/apply-patched-asar.ps1 `
  -InstallDir "D:\Soft\DSH" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json"
```

输出包含 `Report verified: patched archive was built from this exact app.asar.`，并正确检测到
7 个 `DeepSeek Harness.exe` 进程、提示 `DRY RUN`。**未执行 `-Apply`**，也未启动打过补丁的桌面壳。

## 2.2 v2 启动重试现场验证（已执行）

应用 v2（live `807f4eb3…044b`）后，连续两次托盘重启均成功；其中 18:12 的一次在旧故障同一时刻触发：

```text
2026-11-19T10:12:49.550Z welcome-state read failed (attempt 1): fetch failed ECONNRESET; retrying
```

重试后窗口正常打开；应用 v2 后无新增 crash report；`host-events.log` 只有 `close code=0`；
`host-stderr.log` 无 Host 错误。用户确认不再弹恢复框。该验证覆盖了“新进程存活但启动状态读取失败”的真实场景。

## 3. 手工功能测试
前置：在**测试构建/安装副本**中应用壳补丁，并把 `tray-restart-watchdog.cjs` 放到 `resources/`。
用 `Get-CimInstance` 记录重启前后的进程信息：

```powershell
$cutoff = Get-Date
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine |
  Format-List | Out-String -Width 400
```

### T1 托盘菜单（需求 1、5）

- 右键托盘图标：应看到 `打开 DeepSeek Harness`、`重启 DeepSeek Harness`、分隔线、`退出 DeepSeek Harness`。
- 中文系统显示“重启 DeepSeek Harness”；英文系统显示“Restart DeepSeek Harness”；其它语言为 `<Restart 的本地化> DeepSeek Harness`。
- `Open` 点击后仍聚焦主窗口；`Quit` 位置与行为不变；分隔线数量不变。
- 与未打补丁的构建逐项对比，除新增项外无差异。

### T2 一键重启（需求 2、3）

1. 记录旧主进程 PID、`ExecutablePath`、`CommandLine`、`CreationDate`。
2. 点击 `重启 DeepSeek Harness`。
3. 等待新窗口出现；记录新 PID/CommandLine。
4. 断言：
   - 旧 PID 消失；新 PID 不同且 `CreationDate > cutoff`；
   - 新旧 `ExecutablePath` 相同；`CommandLine` 除进程 ID 外参数部分相同
     （开发模式下 argv 可能包含入口路径，按实际比较）；
   - 没有出现“双实例”或单实例锁冲突提示。

### T3 无残留（需求 2）

重启完成后：

```powershell
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CreationDate -lt $cutoff } |
  Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine
```

- 结果为空（或只剩与本次重启无关、且不是旧主进程后代的进程）。
- 检查 Host 子进程（`--expose-internals` + `dsh-desktop-host`）没有旧 PID 残留。
- 检查 `restart.log`：正常路径应为 `watchdog` 看到旧进程退出、新实例出现、`no residual old-tree processes`。

### T4 退出超时（需求 4）

需要一个可控的故障注入构建：让 Host 忽略 `shutdown`（或在测试构建的 `DesktopHostProcess.stop()` 中延长等待），
然后点击重启。

断言：

- 壳侧按 10s/5s/5s 升级，日志可见；
- 看门狗在 30s 后按 PID 逐级 `taskkill /F`（不用 `/T`，避免杀掉自身和 conhost）；
- 旧进程最终消失；新进程启动；
- `last-result.json` 的 `status` 为 `ok`，日志含 `force-killing`；
- 若强制终止后仍存活，则 `status=failed`、`code=exit-timeout`，弹出错误框，且**没有**启动第二个实例。

### T5 启动失败（需求 4）

在测试构建中让看门狗快照指向一个不可执行/已删除的 exe（或临时改 ACL 拒绝执行）：

- 看门狗 `spawn` 失败；
- `last-result.json`：`status=failed`、`code=spawn-error`；
- 弹出消息框，含原因、exe、日志路径；
- 不出现无限重试或残留看门狗。

### T6 权限不足（需求 4）

- 以普通用户运行 DSH，目标 exe 位于需要管理员权限的目录（测试副本）；
- 预期：不自动弹 UAC；日志/回执记录 `EACCES/EPERM`；消息框提示“以管理员身份运行/检查路径”。
- 以管理员运行同一构建：重启应成功（看门狗继承管理员令牌）。

### T7 连点与并发

- 快速双击“重启 DeepSeek Harness”：只触发一次重启；日志只有一条 `restart requested`；第二次被 `inFlight` 拒绝。
- 在退出过程中再次点击：无操作、无异常。

### T8 有运行中任务时重启

- 启动一个长任务（生成中、终端命令或后台 job），点击重启；
- 任务被中断；重启后会话可打开，已持久化的事件不丢；
- 日志与错误框（如有）不包含 API key、token、完整环境变量。

### T9 插件命令（需求 5）

- 未打壳补丁：插件安装后 `/restart-dsh` 返回“未安装托盘补丁”，**不**杀进程。
- 打好补丁：`/restart-dsh` 触发与托盘项相同的重启；`--help` 只显示用法。
- 安装/卸载 bundle 后，托盘菜单与其它插件行为不变。

### T10 升级/回滚

- DSH 桌面壳升级后，`check-patch.mjs` 应对新 `main.js` **失败**（锚点变化），禁止复用旧补丁；
- 恢复旧 `app.asar` 与旧 watchdog 文件后，托盘项与重启功能恢复；
- 升级覆盖补丁属于预期，需重新应用或等待官方合并。

## 4. 验收门槛

- 自动化：17/17 通过；补丁校验通过；`git apply` 结果字节一致。
- 手工：T1、T2、T3、T9 必须全过；T4/T5/T6 至少各完成一次故障注入；T7/T8 抽测。
- 日志：每次重启都有 `restart.log` 时间线；失败有 `last-result.json` 与用户提示。
- 安全：快照无环境变量；不自动提权；残留清理只针对捕获的旧进程树。

## 5. 已知未覆盖

- 真实托盘渲染与点击后的整机重启未在本会话执行（会终止当前会话，且需要先改 app.asar）。
- macOS/Linux 无该托盘实现；`process.platform !== "win32"` 时壳根本不创建 `DesktopTray`。
- 没有自动化 UI 截图对比；T1 需人工/后续用桌面自动化工具验收。
