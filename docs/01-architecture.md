# 架构：托盘归谁所有，以及为什么必须分两层

本文所有结论来自本机安装的 **DSH 0.2.2-rc.5**（Desktop profile），源码位于
`D:\Soft\DSH\resources\app.asar`。不同版本的行号会变化，但符号名与边界不变。

## 1. 运行结构

```
DeepSeek Harness.exe                       Electron 主进程（桌面壳）
├─ BrowserWindow / renderer                 Web UI（插件 Client 半运行在这里）
├─ Tray (DesktopTray)                       ← “打开 / 退出”右键菜单
├─ crashpad / GPU / utility …
└─ DeepSeek Harness.exe  --expose-internals  (ELECTRON_RUN_AS_NODE=1, IPC)
   └─ @deepseek-ai/dsh-desktop-host          Host 进程（Cordis Loader）
      ├─ Loader 插件树（profile bundles）
      ├─ agents / sessions / tools / webserver
      └─ MCP、终端、子代理、浏览器等由插件管理的子进程
```

- 桌面壳入口：`resources/app.asar/lib/main.js`（`@deepseek-ai/dsh-desktop` 0.2.2-rc.5）。
- Host 入口：`resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`。
- Host 由 `DesktopHostProcess.start()` 启动：
  `main.js` 11782–11802，`spawn(this.node, [--expose-internals, entry, …], { stdio: ['ignore','pipe','pipe','ipc'] })`。
- 因此 Cordis 插件代码运行在 **Host 子进程**，不是 Electron 主进程。

## 2. 托盘菜单是硬编码的，没有插件扩展点

`main.js` 的 `DesktopTray`（0.2.2-rc.5 约 19939–19983 行）：

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

搜索整个 `lib/main.js`，`new Tray(` / `setContextMenu(` 只出现在这里；没有
`registerTrayItem`、没有从 profile 读取菜单、没有 IPC 允许插件追加菜单项。
托盘创建时机在 `main()` 内（约 21380 行），`if (process.platform === "win32") try { tray = new DesktopTray({…}) }`。

Cordis 侧也没有对应 Service：用 `cordis_inspect_query` 查询 Host Service 目录，与桌面/窗口相关的只有
`workspaceDesktop()`（打开文件管理器）之类的业务能力；没有 tray / window / lifecycle 服务。

**结论：纯 Cordis bundle 无法在 DSH 原生托盘菜单中追加菜单项。** 任何声称能做到的方案，要么在改
Electron 壳，要么另起一个托盘图标（不是同一个菜单）。

## 3. 桌面壳的生命周期只对自己开放

`main.js` 的关键生命周期：

- `quitWithoutConfirmation()`（约 20072 行）：`skipQuitConfirmation = true; app.quit()`。
- `before-quit`（约 21678 行）：首次触发时 `event.preventDefault()`，进入 `finishQuit()`。
- `finishQuit()`（约 21648 行）：隐藏窗口、销毁托盘、停止更新检查，然后并行：
  - `backend.close()` → `DesktopHostProcess.stop()`；
  - 其它视图/拖拽/账号订阅清理；
  - 全部结束后 `app.quit()`。
- `DesktopHostProcess.stop()`（约 11933 行）有明确的三级超时：
  1. `child.send({type:"shutdown"})`，等待 10s 优雅退出；
  2. 超时 `SIGTERM`，再等 5s；
  3. 超时 `SIGKILL`，再等 5s；仍不退则抛错。
- 崩溃恢复与开发菜单已经使用 `app.relaunch()` + `quitWithoutConfirmation()`（约 20093、21348 行）。
  这是现有版本里唯一“干净重启”的原生路径。

Host 侧没有 `quit`/`relaunch` 控制通道。`DesktopHostProcess` 只接受
`shutdown`、`file-drag-*`、`quit-inspection`、`update-tasks` 这几种控制消息；
`isDesktopHostEvent()`（约 11647 行）对未知 IPC 消息直接 `fail()` 并 `SIGTERM` Host。
所以插件也不能靠“发给壳一条消息”来间接重启——除非壳侧先加白名单和处理分支。

## 4. 方案取舍

| 方案 | 满足需求 1 | 风险/代价 | 结论 |
|---|---|---|---|
| A. Cordis bundle 直接 `taskkill` 父进程 + 自带 supervisor | 否（托盘没变） | 绕过 `finishQuit`，不知道单实例锁/启动环境；Host 插件无法在壳退出后弹 UI；重复实现 Electron 已有退出链；容易残留 | 拒绝 |
| B. 插件另起一个托盘图标 | 否（是第二个图标，不是 DSH 菜单） | Windows 11 默认折叠到溢出区；与 DSH 图标重复；用户困惑 | 拒绝 |
| C. 桌面壳补丁：托盘追加一项 + `app.relaunch()` | **是** | 需要改 `app.asar`（重打包/签名/更新覆盖）；官方不支持 | **采用** |
| D. 官方把该功能合入桌面壳 | 是 | 需要 DSH 团队发布 | 长期建议 |

方案 C 的额外设计：

- **看门狗**（`tray-restart-watchdog.cjs`）在壳退出后仍能观测并提示启动失败；
- 壳补丁同时增加一个**受控的 Host→壳 IPC**（`restart-app`），让可选的 Cordis bundle 复用同一条重启路径，
  而不是自己杀进程；
- 菜单只“追加”一项，原 Open/Quit 的 label、顺序、click 行为完全保留（有单元测试）。

## 5. 为什么还提供一个 Cordis bundle

需求 5 要求“兼容现有插件机制”。托盘本身不可扩展，但**触发入口**可以扩展：

- bundle 注册 `/restart-dsh`，走 `restart-app` IPC → 壳的同一个 `restartFromTray()`；
- bundle 不碰 `process.kill`、不猜启动参数、不读写 `cordis.patch.yml`；
- 未打壳补丁时命令返回明确说明，不会产生副作用。

这样“托盘菜单”由壳补丁负责，“插件机制兼容”由 bundle 负责，两者的进程控制逻辑只有一份。

## 6. 一个容易忽略的事实

`app.relaunch()` 默认就以**当前可执行文件与当前 argv** 重启（Electron 文档语义），
因此需求 3 不需要手工解析命令行。看门狗只是在 `relaunch` 没有生效（例如旧进程被强制终止）时，
才用快照中的 `execPath + argv.slice(1) + cwd` 兜底。快照里**不写环境变量**，避免把 API key
等秘密落盘；看门狗直接继承壳的环境，并在启动 GUI 前清掉 `ELECTRON_RUN_AS_NODE`。
