# 按已批准计划展示执行进度

任务标题和用户原文保留在历史、目标节点中。执行工作区顶部优先展示已批准计划的当前步骤，例如“第 3/5 步：编写拖拽交互 · 已完成 2/5”；下方活动条展示具体模型/工具操作。拓扑图增加按计划顺序排列的步骤节点，当前模型节点带上正在处理的步骤上下文。

## 进度来源

`studio.plan.propose` 的确认结果返回已批准步骤的 ID、名称和说明。确认后模型使用 `studio.plan.update` 上报边界变化：

```json
{
  "updates": [
    { "stepId": "<已批准步骤 ID>", "status": "completed", "summary": "已创建场景光源与共享几何资源" },
    { "stepId": "<下一步骤 ID>", "status": "in_progress", "summary": "根据引擎命中结果处理拖拽方向" }
  ]
}
```

状态允许 pending、in_progress、completed、blocked，可同时上报多个独立步骤进行中。每次更新先完整校验：只能更新当前任务已批准的步骤，不能修改步骤内容、审批选择或验收条件；未知、重复、被拒绝的 ID 均不会产生部分更新。只在步骤边界报告，不要求每个工具额外上报。

进度存储在现有 plan conversation projection 的 items.executionStatus / executionSummary 中，和审批 status 分开，通过既有 journal/artifact 恢复。跨回合的 approvedPlan continuation 保留精确 ID 及进度；切换任务时按 taskId 隔离，旧记录才使用 session/turn 归属回退。

## 显示规则

- 没有进度记录时显示“等待 Agent 更新执行步骤”，不能从工具数量或名称猜测第几步。
- 多步并行时显示多个步骤名称；已完成数来自明确报告。
- 步骤 completed 是 Agent 的执行进度声明，不能替代权威验收证据，也不能改变 TaskSpec/TaskRun 的终态。
- 回合终止时停止步骤的运行高亮；此前进行中的步骤显示结果待核实或已取消。
- UI 使用稳定 plan/step ID 派生节点，更新保留 DOM 和已打开的详情面板。步骤节点可查看具体说明和上报结果；未覆盖的历史模型轮次不会被重新归到当前步骤。

## 验证

包含校验原子性、并行步骤、进度与审批/验收分离、旧记录回退、任务隔离、稳定节点 ID、图摘要校验、实际 Host 工具往返、Electron 步骤切换与详情面板保留。截图使用隔离测试场景，不修改用户运行中的项目。
