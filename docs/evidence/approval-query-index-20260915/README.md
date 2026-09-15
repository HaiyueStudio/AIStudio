# 大日志下的审批消费查询

原因和实现见 [精确关联查询索引](../../architecture/operation-log-exact-query-index.md)。日志指出 r10 的 `play.start` 在审批阶段因候选窗口 10,718 超出 10,000 失败；同轮按 toolCallId 查询诊断也触发相同限制。

- 日志基础回归 16 项通过。
- 完整 operation-log 回归 24 项通过，含查询、项目历史复制/重启、日志保留和性能验证。使用 `TMPDIR=/private/tmp` 避免 macOS 默认临时目录 `/var` 符号链接被已有项目目录保护拒绝。
- Host 审批恢复回归 2 项通过。
- operation-log 与应用构建通过。
- 全仓检查通过类型与边界等前置检查，最终停在既有 M14 capability census 验证指纹过期；见 `check.log`。未重录基线。

仅包含隔离测试输出；未复制用户原始日志、未改用户工程或重启应用。
