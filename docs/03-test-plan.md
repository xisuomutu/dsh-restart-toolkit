# 测试计划

> 文档状态：已发布  
> 适用范围：DSH Desktop 0.2.2-rc.5（Windows）  
> 工具包版本：1.0.0  
> 相关文档：[架构设计](01-architecture.md) · [进程生命周期](02-process-lifecycle.md)

## 1. 目的与范围

本文定义 DSH Restart Toolkit 的测试策略、自动化测试、构建校验、手工验收矩阵和验收标准。
测试对象包括：

- 托盘菜单与重启编排；
- watchdog 进程生命周期与残留清理；
- 附加式 ASAR 补丁的构建与部署校验；
- 可选 `/restart-dsh` 命令；
- 升级与回滚。

## 2. 参考环境

| 项 | 值 |
|---|---|
| 操作系统 | Windows 11（26300） |
| DSH | DeepSeek Harness Desktop 0.2.2-rc.5 |
| Node.js | 26.x（仅测试/构建；要求 20+） |
| PowerShell | 5.1 |
| 用户数据目录 | `%APPDATA%\@deepseek-ai\dsh-desktop` |
| 网络 | 自动化测试不联网、不下载依赖 |

测试机应使用**测试构建或安装副本**；直接修改正在运行的安装会终止当前会话。

## 3. 测试策略

| 层级 | 目标 | 方式 |
|---|---|---|
| 单元测试 | 菜单模板、重启编排、命令参数 | Node 内置 test runner + mock |
| 集成测试 | watchdog 真实进程、超时、强制清理、残留 | 临时进程树 + PowerShell |
| 构建校验 | 锚点、补丁字节一致、ASAR 回读 | `check-patch` / `build-patch` / `repack-asar` |
| 部署校验 | report/source 匹配、dry-run、备份 | `apply-patched-asar.ps1` |
| 手工验收 | 托盘 UI、整机重启、权限、升级 | 测试构建/安装副本 |

## 4. 自动化测试

### 4.1 执行命令

```powershell
cd <工具包目录>
node --test desktop-shell/test/tray-restart.test.mjs
node --test desktop-shell/test/watchdog.test.mjs
node --test plugin/dsh-restart-command/test/command.test.mjs
```

### 4.2 覆盖矩阵

| 文件 | 用例 |
|---|---|
| `tray-restart.test.mjs` | 菜单只新增一项、原 Open/Quit label 与顺序不变；点击回调正确；单飞；退出中拒绝；`relaunch` 抛错不退出、弹框、解除单飞；watchdog 缺失仍重启；watchdog spawn 失败仍重启；`quit` 抛错；快照不含环境变量 |
| `watchdog.test.mjs` | 旧进程退出但无 relaunch → 兜底启动成功；旧进程超时 → 逐 PID 强制终止后成功；不可执行文件 → receipt `failed` + exit 1；watchdog 是旧主子进程时，强制清理旧树不会自杀 |
| `command.test.mjs` | `/restart-dsh` 发送 `restart-app`；`--help` 不发送；缺少壳补丁返回明确错误；IPC 失败返回错误 |

### 4.3 预期结果

```text
tray-restart.test.mjs   9 passed
watchdog.test.mjs       4 passed
command.test.mjs        4 passed
合计                    17 passed
```

## 5. 构建与 ASAR 验证

### 5.1 补丁锚点与语法

```powershell
# 从 ASAR 复制出 lib/main.js（只读复制，不改 app.asar）
# 只读校验锚点、替换次数、语法
node desktop-shell/patch/check-patch.mjs <path-to>\main.js
```

验收点：

- `check-patch.mjs` 输出 `all anchors matched once`；
- 生成文件 `node --check` 退出码 0；
- 每个锚点只替换一次，无部分应用。

### 5.2 `git apply` 字节一致性

```powershell
mkdir <tmp>\lib
copy <path-to>\main.js <tmp>\lib\main.js
cd <tmp>
git -c core.autocrlf=false apply --check --whitespace=nowarn <repo>\desktop-shell\patch\main.js.patch
git -c core.autocrlf=false apply --whitespace=nowarn <repo>\desktop-shell\patch\main.js.patch
# 与 build-patch.mjs 输出比较 SHA-256
```

必须使用 `-c core.autocrlf=false`，否则 Git 会把 LF 转为 CRLF，导致字节不一致。

### 5.3 附加式 ASAR 构建

```powershell
node desktop-shell/patch/repack-asar.mjs `
  "<DSH_INSTALL>\resources\app.asar" `
  "$env:TEMP\app.patched.asar" `
  --report "$env:TEMP\report.json"
```

参考环境结果（v3，从原始备份构建）：

| 项 | 值 |
|---|---|
| `lib/main.js` | 848,505 → 854,312 字节 |
| main.js offset | 201,569,178 → 203,411,600（追加到末尾） |
| 头部 JSON | 5,671,182 / 5,671,389 字节（原槽位填充） |
| data start | 5,671,408（不变） |
| 归档大小 | 209,083,008 → 209,937,320 |
| 自校验 | main.js 回读哈希一致；未改文件字节一致 |
| `mainPatchedSha256` | `677adcf6047b1842b0684f95175e008fdee02c2d084a9112b08c7df98cbbc1d2` |
| 输出 archive SHA-256 | `592987efc8e2162b2383f2b09462f1d70b03e217a9014737cf4933f243dce568` |

独立读取验证：使用安装自带 Electron 以 `ELECTRON_RUN_AS_NODE=1` 读取
`app.patched.asar/lib/main.js`，返回 854,312 字节，哈希与 `main.patched.js` 一致；
`package.json` 解析为 `@deepseek-ai/dsh-desktop`，`lib` 目录可正常列举。

### 5.4 可复现验证

```powershell
# 原始未打补丁
powershell -File tests/verify-asar-patch.ps1 -InstallDir "<DSH_INSTALL>"

# 已打补丁：从原始备份构建
powershell -File tests/verify-asar-patch.ps1 `
  -SourceAsar "<DSH_INSTALL>\resources\app.asar.bak-20261119-174449" `
  -InstallDir "<DSH_INSTALL>"
```

### 5.5 部署 dry-run

```powershell
powershell -File desktop-shell/patch/apply-patched-asar.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\app.patched.asar" `
  -Report "$env:TEMP\report.json"
```

输出必须包含 `Report verified` 与 `DRY RUN`，并正确识别当前运行中的 DSH 进程数。
未执行 `-Apply` 时不得修改安装目录。

## 6. 手工验收矩阵

前置：在测试构建/安装副本中应用壳补丁，并把 `tray-restart-watchdog.cjs` 放到 `resources/`。
记录重启前后进程信息：

```powershell
$cutoff = Get-Date
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine |
  Format-List | Out-String -Width 400
```

### T1 托盘菜单

- 右键托盘应看到：`打开 DeepSeek Harness`、`重启 DeepSeek Harness`、分隔线、`退出 DeepSeek Harness`。
- 中文系统显示“重启 DeepSeek Harness”；英文系统显示“Restart DeepSeek Harness”；
  其它语言为 `<Restart 的本地化> DeepSeek Harness`。
- `Open` 仍聚焦主窗口；`Quit` 位置与行为不变；分隔线数量不变。
- 与未打补丁构建逐项对比，除新增项外无差异。

### T2 一键重启

1. 记录旧主进程 PID、`ExecutablePath`、`CommandLine`、`CreationDate`。
2. 点击“重启 DeepSeek Harness”。
3. 等待新窗口出现；记录新 PID/CommandLine。
4. 断言：
   - 旧 PID 消失；新 PID 不同且 `CreationDate > cutoff`；
   - 新旧 `ExecutablePath` 相同；`CommandLine` 除进程 ID 外参数部分相同
     （开发模式下 argv 可能包含入口路径，按实际比较）；
   - 无“双实例”或单实例锁冲突提示。

### T3 无残留

重启完成后：

```powershell
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CreationDate -lt $cutoff } |
  Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine
```

验收：

- 结果为空，或只剩与本次重启无关且不是旧主进程后代的进程；
- Host 子进程（`--expose-internals` + `dsh-desktop-host`）没有旧 PID 残留；
- `restart.log` 显示旧进程退出、新实例出现、`no residual old-tree processes`。

### T4 退出超时

使用可控故障注入构建：让 Host 忽略 `shutdown`，或在测试构建中延长
`DesktopHostProcess.stop()` 的等待。

断言：

- 壳按 10s/5s/5s 升级，日志可见；
- watchdog 30s 后按 PID 逐级 `taskkill /F`（不用 `/T`，不杀自身和 conhost）；
- 旧进程最终消失，新进程启动；
- `last-result.json` 的 `status=ok`，日志含 `force-killing`；
- 若强制终止后仍存活，`status=failed`、`code=exit-timeout`，弹框且不启动第二实例。

### T5 启动失败

让 watchdog 快照指向不可执行/已删除的 exe（或临时 ACL 拒绝执行）：

- watchdog `spawn` 失败；
- `last-result.json`：`status=failed`、`code=spawn-error`；
- 消息框包含原因、exe、日志路径；
- 无无限重试或残留 watchdog。

### T6 权限不足

- 普通用户运行 DSH，目标 exe 位于需要管理员权限的测试目录；
- 预期：不自动弹 UAC；日志/回执记录 `EACCES/EPERM`；提示以管理员运行或检查路径；
- 以管理员运行同一构建：重启成功（watchdog 继承管理员令牌）。

### T7 连点与并发

- 快速双击“重启 DeepSeek Harness”：只触发一次；日志只有一条 `restart requested`；
  第二次被 `inFlight` 拒绝；
- 退出过程中再次点击：无操作、无异常。

### T8 有运行中任务时重启

- 启动长任务（生成中、终端命令或后台作业），点击重启；
- 任务被中断；重启后会话可打开，已持久化事件不丢；
- 日志与错误框不包含 API key、token 或完整环境变量。

### T9 插件命令

- 未打壳补丁：`/restart-dsh` 返回“未安装托盘补丁”，不杀进程；
- 打补丁后：`/restart-dsh` 触发与托盘项相同的重启；`--help` 只显示用法；
- 安装/卸载 bundle 后，托盘菜单与其它插件行为不变。

### T10 升级/回滚

- DSH 升级后，`check-patch.mjs` 应对新 `main.js` 失败（锚点变化），禁止复用旧补丁；
- 恢复旧 `app.asar` 与 watchdog 后，托盘项与重启功能恢复；
- 升级覆盖补丁属于预期，需重新应用或等待官方合并。

## 7. 验收标准

| 类别 | 标准 |
|---|---|
| 自动化 | 17/17 通过；补丁锚点校验通过；`git apply` 结果字节一致 |
| 手工 | T1、T2、T3、T9 必须通过；T4/T5/T6 至少各完成一次故障注入；T7/T8 抽测 |
| 日志 | 每次重启有 `restart.log` 时间线；失败有 `last-result.json` 与用户提示 |
| 安全 | 快照无环境变量；不自动提权；残留清理只针对捕获的旧进程树 |

## 8. 未覆盖与风险

- macOS/Linux 没有该托盘实现；`process.platform !== "win32"` 时桌面壳不创建 `DesktopTray`。
- 未做自动化 UI 截图对比；T1 需人工或桌面自动化工具验收。
- 故障注入 T4/T5/T6 需要可控测试构建或临时 ACL，不适合在生产安装上执行。
- ASAR 完整性、企业签名和 EDR 策略可能使部署方案失效；测试前先运行 `doctor.ps1`。

## 9. 验证记录

参考环境（2026-11-19 至 2026-11-20）结果：

- 17/17 自动化测试通过；
- `doctor.ps1` 对原始 0.2.2-rc.5 包检查通过：锚点匹配、ASAR integrity disabled、
  RunAsNode enabled；
- 工具包从原始备份重建的归档与参考环境 v3 一致：
  `592987efc8e2162b2383f2b09462f1d70b03e217a9014737cf4933f243dce568`；
- 实机验证：v2 启动重试在 18:12 捕获到 `ECONNRESET` 后恢复，无新增 crash report，
  Host `close code=0`。

## 10. 相关文档

- [架构设计](01-architecture.md)
- [进程生命周期](02-process-lifecycle.md)
- [安装指南](../INSTALL.md)
