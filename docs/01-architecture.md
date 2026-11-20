# 架构设计

> 文档状态：已发布  
> 适用范围：DSH Desktop 0.2.2-rc.5（Windows，Electron 桌面壳）  
> 工具包版本：1.0.0  
> 相关文档：[进程生命周期](02-process-lifecycle.md) · [测试计划](03-test-plan.md)

## 1. 目的与范围

本文说明 DSH Restart Toolkit 的架构边界、组件职责和关键设计决策，回答以下问题：

- 托盘菜单归谁所有，为什么 Cordis 插件无法直接扩展；
- 为什么重启必须由桌面壳发起，watchdog 只做退出后的观测；
- 为什么工具包同时提供桌面壳补丁和可选的 Cordis bundle。

本文不描述具体安装命令；安装步骤见 [../INSTALL.md](../INSTALL.md)，补丁实现细节见
[../desktop-shell/README.md](../desktop-shell/README.md)。

## 2. 版本基线

| 项 | 基线 |
|---|---|
| 操作系统 | Windows 10/11 |
| DSH | DeepSeek Harness Desktop 0.2.2-rc.5 |
| 桌面壳入口 | `resources/app.asar/lib/main.js` |
| Host 入口 | `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` |
| 托盘实现 | `DesktopTray`（Electron `Tray` + `Menu.buildFromTemplate`） |

不同版本的源码行号会变化；本文引用符号名和边界，不把行号作为稳定接口。

## 3. 进程模型

```text
DeepSeek Harness.exe                       Electron 主进程（桌面壳）
├─ BrowserWindow / renderer                 Web UI（插件 Client 半运行于此）
├─ Tray (DesktopTray)                       原生托盘与右键菜单
├─ crashpad / GPU / utility
└─ DeepSeek Harness.exe  --expose-internals  (ELECTRON_RUN_AS_NODE=1, IPC)
   └─ @deepseek-ai/dsh-desktop-host          Host 进程（Cordis Loader）
      ├─ Loader 插件树（profile bundles）
      ├─ agents / sessions / tools / webserver
      └─ MCP、终端、子代理、浏览器等由插件管理的子进程
```

关键约束：

1. Cordis 插件运行在 **Host 子进程**，不在 Electron 主进程。
2. 托盘由桌面壳主进程创建和持有；Host 没有托盘句柄。
3. 桌面壳的退出、单实例锁、`app.relaunch()` 和更新检查只在主进程内可用。
4. Host 与桌面壳之间只有受控 IPC；未知消息会被 `isDesktopHostEvent()` 拒绝。

## 4. 托盘扩展边界

`DesktopTray` 在 0.2.2-rc.5 中直接构建固定菜单：

```js
var DesktopTray = class {
  constructor(options) {
    const tray = new Tray(nativeImage.createFromPath(options.iconPath));
    tray.on("click", () => options.open());
    this.relabel();
  }
  relabel() {
    const { messages } = this.options.locale();
    tray.setToolTip(messages.aboutProduct);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: messages.openApplication, click: () => this.options.open() },
      { type: "separator" },
      { label: messages.quitApplication, click: () => this.options.quit() },
    ]));
  }
};
```

对整个 `lib/main.js` 的检查结论：

- `new Tray(` / `setContextMenu(` 仅出现在 `DesktopTray`；
- 没有 `registerTrayItem`、profile 菜单加载或菜单追加 IPC；
- Cordis Host Service 目录中没有 tray / window / lifecycle 服务；
- 托盘创建受 `process.platform === "win32"` 限制。

**结论：纯 Cordis bundle 无法向 DSH 原生托盘追加菜单项。** 可行的实现只有：

- 修改桌面壳（本工具包方案）；
- 让 DSH 官方合入该能力；
- 另起一个独立托盘图标（不是同一个菜单，已排除）。

## 5. 生命周期边界

桌面壳提供唯一的干净重启路径：

| 阶段 | 机制 | 说明 |
|---|---|---|
| 请求退出 | `quitWithoutConfirmation()` | 设置 `skipQuitConfirmation`，调用 `app.quit()` |
| 拦截退出 | `before-quit` | 首次触发时 `event.preventDefault()`，进入 `finishQuit()` |
| 优雅关闭 | `finishQuit()` | 隐藏窗口、销毁托盘、停止更新检查，等待后台与 Host 退出 |
| Host 关闭 | `DesktopHostProcess.stop()` | `shutdown` 10s → `SIGTERM` 5s → `SIGKILL` 5s |
| 重启 | `app.relaunch()` | 使用当前可执行文件与 argv 调度新实例 |

Host 侧没有 `quit` / `relaunch` 控制通道；`DesktopHostProcess` 只接受
`shutdown`、`file-drag-*`、`quit-inspection`、`update-tasks` 等控制消息。插件不能通过
“给壳发一条消息”间接重启，除非壳侧先增加白名单和处理分支。

## 6. 方案评估

| 方案 | 满足托盘需求 | 主要风险 | 结论 |
|---|---|---|---|
| Cordis bundle 直接 `taskkill` 父进程 + supervisor | 否（托盘未变） | 绕过 `finishQuit`，不了解单实例锁与启动环境；Host 退出后无法弹 UI；重复实现退出链，易残留 | 拒绝 |
| 插件另起托盘图标 | 否（第二个图标） | Windows 11 折叠到溢出区；与 DSH 图标重复；用户困惑 | 拒绝 |
| 桌面壳补丁：追加菜单项 + `app.relaunch()` | 是 | 需要改 `app.asar`，受签名/完整性/更新影响；官方不支持 | **采用** |
| 官方合入桌面壳 | 是 | 需要 DSH 团队发布 | 长期建议 |

## 7. 选定设计

### 7.1 组件职责

| 组件 | 职责 |
|---|---|
| `desktop-shell/patch` | 修改桌面壳 `lib/main.js`：新增托盘项、`restartFromTray()`、受控 `restart-app` IPC、启动重试与 Host 日志 |
| `desktop-shell/runtime/tray-restart-watchdog.cjs` | 壳退出后观测旧进程退出、新实例启动与稳定期；超时强制清理旧进程树；写回执/弹框 |
| `desktop-shell/src/tray-restart.js` | 源码构建用的等价模块，供官方合并或自定义构建 |
| `plugin/dsh-restart-command` | 可选 Cordis bundle：`/restart-dsh` 通过 `restart-app` IPC 触发同一重启路径 |

### 7.2 重启编排

1. `restartFromTray()` 检查 `trayRestartInFlight` / `quitting` / `shuttingDown`，保证幂等。
2. 写入启动快照（`process.execPath`、`process.argv.slice(1)`、`cwd`），不写环境变量。
3. 以 `detached: true`、`ELECTRON_RUN_AS_NODE=1` 拉起 watchdog。
4. 调用 `app.relaunch()`。
5. 调用 `quitWithoutConfirmation()`，进入桌面壳退出链。

`app.relaunch()` 默认使用当前可执行文件与 argv，因此不需要手工解析命令行；watchdog 仅在
`relaunch` 未生效时用快照兜底启动。快照不落盘环境变量，避免 API key 等秘密进入日志。

### 7.3 为什么保留 Cordis bundle

托盘本身不可扩展，但**触发入口**可以扩展：

- bundle 注册 `/restart-dsh`，通过壳的 `restart-app` IPC 调用同一个 `restartFromTray()`；
- bundle 不调用 `process.kill`，不猜启动参数，不修改 `cordis.patch.yml`；
- 未打壳补丁时返回明确错误，不产生副作用。

这样“托盘菜单”由桌面壳补丁负责，“插件机制兼容”由 bundle 负责，进程控制逻辑只有一份。

## 8. 兼容性与约束

| 约束 | 影响 |
|---|---|
| 仅 Windows | 桌面壳只在 win32 分支创建 `DesktopTray`；macOS/Linux 无该托盘实现 |
| 仅 Desktop | `dsh web` / CLI 没有 Electron 托盘与重启链 |
| 版本绑定 | 补丁锚点针对 0.2.2-rc.5 的 `lib/main.js`；升级后必须重新校验 |
| ASAR 完整性 | 若 `EnableEmbeddedAsarIntegrityValidation` 开启，已安装应用补丁方案失效 |
| 签名/策略 | Authenticode、企业策略、EDR 可能阻止修改后的资源 |
| 更新覆盖 | 桌面壳升级会覆盖 `app.asar`，需重新应用或改用源码构建 |

## 9. 设计决策记录

| ID | 决策 | 理由 | 替代方案 |
|---|---|---|---|
| ADR-001 | 由桌面壳发起重启 | 只有主进程拥有 `app.relaunch()`、单实例锁与退出链 | 插件杀父进程（已拒绝） |
| ADR-002 | watchdog 在壳退出前拉起 | `relaunch` 无完成回调；壳退出后无法再弹 UI | 壳内轮询（无法跨退出） |
| ADR-003 | 菜单只追加一项 | 保留原 Open/Quit 的 label、顺序和 click 行为 | 重建菜单（兼容风险） |
| ADR-004 | 使用附加式 ASAR 补丁 | 不重打包 209 MB 文件，减少字节改动，可回读校验 | 全量解包/重打包 |
| ADR-005 | 启动状态读取重试 | 实机存在 Host 就绪后的瞬时 `ECONNRESET` 竞态 | 仅依赖 DSH 恢复对话框 |
| ADR-006 | 不自动提权 | 避免“一键重启”突然弹 UAC，保持同一用户令牌 | `Start-Process -Verb RunAs` |

## 10. 相关文档

- [进程生命周期与重启规范](02-process-lifecycle.md)
- [测试计划](03-test-plan.md)
- [桌面壳补丁说明](../desktop-shell/README.md)
- [安装指南](../INSTALL.md)
