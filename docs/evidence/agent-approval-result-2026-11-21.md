# Agent 授权优化验证记录

日期：2026-11-21

默认自动审批已批准方案中的工程内可撤销编辑；“本工程始终允许”覆盖同一工具的不同实体和后端会话。新增本机持久偏好与聊天面板切换，提示词明确避免重复口头索权。首次运行、新代码、外部操作与预算扩张保留显式确认。

只读审计 match3 快照中的 27 次“始终允许”，其中 23 次 component.configure 对应 23 个实体、同一个后端会话，确认旧 target/session 绑定是重复请求的直接原因。未修改游戏工程或历史许可。

验证结果：

- 聚焦验证通过：连续实体编辑、严格模式与外部/运行边界、审计失败不执行、跨实体/后端授权、过期 revision、Host 重建与一次性消费语义。
- 真实 Electron 生产窗口验证默认 auto-review、通过 typed preload 切换 ask、配置落盘及 renderer reload；本机配置损坏、未知版本及额外 secret 字段均回退或拒绝。
- 能力证据 18 组、351 项全部通过，零失败。源码绑定：`sha256:20be72295adc818e7547aad58832a5d34eb8c42e4aa8ef1f913e0cdea15c6696`。
- `npm run check` 完整执行 83 个集成文件，505 项通过、1 项失败，零跳过/取消；命令退出码为 1。其他前置检查均已通过。
- 唯一失败是 product-electron 的既有冻结设备断言：要求 i7-7700，本机 i7-14700KF。未改写或跳过门禁；未取得受认可的大项目性能验收。前次升级验证已有同样限制。
- 生成目录秘密扫描通过（674 个文件）；没有读取真实凭据存储，也没有为此触发真实模型计费生成。

完整日志位于 `.cache/approval-audit/check.log`。本轮变化的集成输出归档到 `.cache/approval-audit/integration-output`，保留 TAP、截图和摘要；Git 中的历史生成证据恢复为原状。此次不推进 milestone 状态。

[实现及授权范围](../adr/0004-project-edit-approval-policy.md) · [机器可读结果](agent-approval-result-2026-11-21.json) · [既有硬件限制](dependency-upgrade-result-2026-11-21.md)
