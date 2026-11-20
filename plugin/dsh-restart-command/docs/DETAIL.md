# 重启 DeepSeek Harness（命令）

## 它做什么

安装后，Web 界面的命令面板会多出 `/restart-dsh`：

- `/restart-dsh`：请求桌面壳完整退出并重启 DeepSeek Harness。
- `/restart-dsh --help`：显示用法。

命令本身不结束任何进程。它向桌面壳发送一次 `restart-app` IPC；桌面壳的托盘补丁会执行：

1. 记录启动快照（可执行文件、argv、cwd）。
2. `app.relaunch()` 调度新实例。
3. `quitWithoutConfirmation()` 走桌面壳原有退出流程：`backend.close()` → `DesktopHostProcess.stop()`（10 秒优雅退出、SIGTERM、SIGKILL 逐级升级）。
4. 独立看门狗等待旧进程退出、确认新进程存活；失败时弹出中文/英文错误框并写日志。

## 前置条件

必须在 Windows Desktop 配置文件中运行，并且桌面壳已应用 `desktop-shell/patch/main.js.patch`。补丁会向 Host 进程注入 `DSH_DESKTOP_RESTART_IPC=1`，并接受 `restart-app` 消息。

未安装补丁时，命令返回：

> 无法重启：当前桌面壳未安装“重启 DeepSeek Harness”托盘补丁。

这是有意为之：Cordis 插件无法直接改原生托盘，也不应在没有桌面壳协调的情况下猜测启动参数、强杀进程树。

## 限制

- 只支持 Windows Desktop；`dsh web`、CLI 和 macOS 会返回错误。
- 重启会中断正在运行的回合、工具调用和终端；会话日志按事件持久化，重启后可以继续。
- 托盘菜单项本身来自桌面壳补丁，不是这个 bundle 安装的。

## 排错

查看 `%APPDATA%\DeepSeek Harness\tray-restart\restart.log`（具体 userData 路径以安装为准）和 `last-result.json`。常见原因：

- 补丁未应用或应用到了错误版本：`DSH_DESKTOP_RESTART_IPC` 未注入。
- 补丁版本与桌面壳版本不匹配：重新运行 `build-patch.mjs` 校验锚点。
- 启动失败/权限不足：看门狗会弹出提示并记录 `spawn-error`、`start-failed` 或 `start-unstable`。
