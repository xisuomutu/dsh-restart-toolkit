# 变更记录

本文件记录 DSH Restart Toolkit 的所有重要变更。格式基于
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。

## [1.0.0] - 2026-11-20

首个公开版本，适用于 DSH Desktop 0.2.2-rc.5（Windows）。

### Added

- 托盘项“重启 DeepSeek Harness” / “Restart DeepSeek Harness”，保留原有打开/退出项。
- `restartFromTray()`：单飞、快照、`app.relaunch()`、`quitWithoutConfirmation()`。
- 独立 watchdog：旧进程退出/新实例启动观测、稳定期校验、超时清理、回执与错误提示。
- 启动加固：欢迎状态 RPC 重试、`startup.log`、`host-stderr.log`、`host-events.log`。
- `doctor.ps1`、`check-compat.mjs`：版本/ASAR/fuse/锚点检查。
- 附加式 `repack-asar.mjs`：不完整重打包，保留其余条目偏移和字节。
- `apply-patched-asar.ps1`：report/source 校验、暂存替换、备份、回滚。
- `apply-after-exit.ps1`：等待 DSH 退出、应用、重启。
- `package-release.ps1`：生成不含 `app.asar` 的发布 ZIP。
- 可选 Cordis bundle：`/restart-dsh`。

### Changed

- 托盘文案从“重启 DSH”改为“重启 DeepSeek Harness”。
- 文档统一为生产级结构：架构、生命周期、测试计划、发布说明；历史事件不再保留独立记录文档。
- 新增文档索引与文档约定。

### Removed

- 删除 `RELEASE.md`：发布流程已由 README、INSTALL、CHANGELOG 覆盖。
- 删除 `docs/04-field-notes.md` 与 `docs/04-troubleshooting.md`：故障排查入口合并到
  INSTALL 与测试计划。

### Fixed

- 修复重启后新实例启动阶段的瞬时 `ECONNRESET` 导致恢复框：增加 3 次重试与 Host 日志。
- 修复 watchdog 强制清理时可能误杀自身/conhost 的问题：按 PID 逐级清理，不使用 `/T`，排除控制台宿主。
- 修复旧进程树残留清理范围：只清理启动前捕获的旧主进程后代，不误杀其他 DSH 实例。

### Security

- 快照不落盘环境变量；日志不记录凭据。
- 不自动提权；权限不足时提示用户手动处理。
- 不修改认证协议、Host 启动参数或插件 Loader。

### Verification

- 自动化：17/17 通过。
- 环境：`doctor.ps1` 在原始 0.2.2-rc.5 包上 `READY`；锚点匹配；ASAR integrity disabled；
  RunAsNode enabled。
- 构建：v3 `lib/main.js` 854,312 字节；
  `mainPatchedSha256=677adcf6047b1842b0684f95175e008fdee02c2d084a9112b08c7df98cbbc1d2`；
  archive `592987efc8e2162b2383f2b09462f1d70b03e217a9014737cf4933f243dce568`。
- 实机验证：v2 启动重试捕获 `ECONNRESET` 后恢复；无新增 crash report；Host `close code=0`。

[1.0.0]: https://github.com/xisuomutu/dsh-restart-toolkit/releases/tag/v1.0.0
