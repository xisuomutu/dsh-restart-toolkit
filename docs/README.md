# 文档索引

本目录收录 DSH Restart Toolkit 的设计、运行规范和测试文档。

| 文档 | 内容 | 读者 |
|---|---|---|
| [01-architecture.md](01-architecture.md) | 进程模型、托盘边界、方案取舍、设计决策 | 维护者、评审者 |
| [02-process-lifecycle.md](02-process-lifecycle.md) | 重启时序、退出链、watchdog 状态机、超时与日志规范 | 维护者、测试、运维 |
| [03-test-plan.md](03-test-plan.md) | 测试策略、自动化测试、构建校验、手工验收矩阵 | 测试、发布负责人 |
| [../INSTALL.md](../INSTALL.md) | 安装、升级、回滚 | 最终用户、部署人员 |
| [../desktop-shell/README.md](../desktop-shell/README.md) | 桌面壳补丁实现与部署细节 | 维护者、二次开发者 |
| [../plugin/dsh-restart-command/docs/DETAIL.md](../plugin/dsh-restart-command/docs/DETAIL.md) | `/restart-dsh` 命令规范 | 插件用户、维护者 |

## 文档约定

- 规范性表述使用“必须 / 应 / 不得”，建议性表述使用“建议 / 可以”。
- 命令默认在 Windows PowerShell 5.1 中执行；路径占位符使用 `<DSH_INSTALL>`、`<工具包目录>`。
- 版本相关的哈希、行号只作为参考环境证据，不作为跨版本稳定接口。
- 历史事件与构建产物不写入主流程文档。
- 文档中的产品名统一为“DeepSeek Harness”；工具包名称为“DSH Restart Toolkit”。

## 版本

| 项 | 值 |
|---|---|
| 工具包 | 1.0.0 |
| 补丁 | v3 |
| DSH Desktop | 0.2.2-rc.5 |
| 平台 | Windows 10/11 |
