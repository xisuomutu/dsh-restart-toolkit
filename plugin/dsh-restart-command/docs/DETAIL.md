# `/restart-dsh` 命令规范

> 文档状态：已发布  
> 适用范围：DSH Desktop 0.2.2-rc.5（Windows），已应用桌面壳补丁  
> 工具包版本：1.0.0  
> 相关文档：[桌面壳补丁](../../../desktop-shell/README.md) · [安装指南](../../../INSTALL.md)

## 1. 用途

`/restart-dsh` 是可选 Cordis bundle，用于从命令面板触发与托盘项相同的桌面重启流程。
托盘菜单项本身由桌面壳补丁提供，不由该 bundle 安装。

## 2. 命令

| 命令 | 行为 |
|---|---|
| `/restart-dsh` | 请求桌面壳完整退出并重启 DeepSeek Harness |
| `/restart-dsh --help` | 显示用法，不发送重启请求 |

## 3. 行为

命令本身不结束任何进程。它向桌面壳发送一次 `restart-app` IPC；桌面壳托盘补丁执行：

1. 记录启动快照（可执行文件、argv、cwd）；
2. `app.relaunch()` 调度新实例；
3. `quitWithoutConfirmation()` 进入桌面壳退出链：
   `backend.close()` → `DesktopHostProcess.stop()`（10s 优雅 → SIGTERM → SIGKILL）；
4. watchdog 等待旧进程退出、确认新进程存活；失败时提示并写日志。

同一路径的详细规范见 [../docs/02-process-lifecycle.md](../../../docs/02-process-lifecycle.md)。

## 4. 前置条件

- Windows Desktop 配置；
- 桌面壳已应用 `desktop-shell/patch/main.js.patch`；
- Host 环境包含 `DSH_DESKTOP_RESTART_IPC=1`；
- 桌面壳接受整数 `requestId` 的 `restart-app` 消息。

未安装补丁时，命令返回：

> 无法重启：当前桌面壳未安装“重启 DeepSeek Harness”托盘补丁。

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| 缺少 `DSH_DESKTOP_RESTART_IPC` | 返回明确错误，不杀进程 |
| IPC 发送失败 | 返回错误，不重试 |
| `--help` | 只显示用法，不发送请求 |
| 壳侧重启失败 | 由桌面壳/watchdog 记录日志并提示 |

## 6. 安全

- 不调用 `process.kill` / `taskkill`；
- 不解析或拼装启动参数；
- 不修改 `cordis.patch.yml`、profile 或其他插件；
- 不读取或写入凭据/环境变量。

## 7. 限制

- 仅支持 Windows Desktop；`dsh web`、CLI 和 macOS 返回错误。
- 重启会中断正在运行的回合、工具调用和终端；会话日志持久化，但进行中的工作不会保留。
- 托盘菜单项来自桌面壳补丁，不是 bundle 安装的。

## 8. 排错

日志目录：

```text
%APPDATA%\@deepseek-ai\dsh-desktop\tray-restart\
  restart.log
  last-result.json
```

常见原因：

- 补丁未应用或应用到了错误版本：`DSH_DESKTOP_RESTART_IPC` 未注入；
- 补丁与桌面壳版本不匹配：重新运行 `build-patch.mjs` / `check-compat.mjs` 校验锚点；
- 启动失败/权限不足：watchdog 记录 `spawn-error`、`start-failed` 或 `start-unstable`。

排错入口见 [安装指南](../../../INSTALL.md) 第 13 节。
