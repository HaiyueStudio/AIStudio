# 精确关联查询与扫描预算

2026-09-15 的 r10 预览恢复在 `stage: approval` 报 `query-scan-budget-exceeded`：窗口包含 10,718 条事件。此前 `diagnostics.query`（带 toolCallId）也在 10,391 条时失败。

恢复审批需查询指定 approvalId 的 `conversation/approval-grant-consumed`，`limit: 1`、`traverseCorrelation: false`。旧查询实现先对整个项目/日志序列窗口检查扫描预算，随后才匹配 ID、kind 和结果 limit。因此 10,718 是候选窗口总量，不是审批必须读取的数量，也不会因此把这些日志全部发送给模型。

现在为明确的 correlation ID 建立内存倒排索引。非遍历查询在项目索引和各精确 ID 索引中选择最小候选集合，应用序列窗口后再检查预算，并继续执行完整的项目、kind、时间和关联条件过滤。审批 ID 不存在时直接返回空结果；不会通过忽略扫描异常来假定授权未消费。

- 仅在 journal 成功写入后增量更新索引。
- 打开日志时从已校验 journal 重建；清理旧 segment 时同步移除旧索引记录。
- projectId 的继承归属继续由原项目索引处理；跨项目过滤不放宽。
- `traverseCorrelation: true` 保持原窗口扫描语义，不因精确种子索引遗漏关联事件。
- 全量查询和过大的候选集合仍遵守 maxQueryScan；未提高全局扫描上限。

回归使用小扫描预算构造同等边界，覆盖精确审批/工具查询、缺失 ID、分页、序列窗口、项目隔离、重启和保留策略清理。未改动用户当前项目或运行中的 Agent 状态。
