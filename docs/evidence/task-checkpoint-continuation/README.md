# 未完成验收与检查点继续

## 本次实际问题

只读检查用户当前任务的项目历史（2026-09-13 01:32–01:40 UTC），对应 prompt profile 3.8.0、项目 r8：

- 七项批准的验收标准全部 pending，持久化证据数量为 0，未执行 Play 验收。
- Agent 在 component.add 后结束，文本解释是预计剩余对象、脚本和 Play 仍需审批。这是提前结束创作，不是本次验收器错误拒绝已有证据。
- 01:40:47 用户点击继续，01:40:54 又回到相同诊断，sessionId/turnId 与原终结回合相同。
- `conversation/retry` 调用旧 `runtime.turns.resume`；Codex 的 `resumeTurn` 返回已有 TurnChannel.stream，并不调用新的 turn/start。实际历史出现旧 project.snapshot toolCallId，随后再次 completed。

只记录必要时间、修订、计数和控制流，不把用户完整对话、项目内容或凭据复制到证据目录。旧任务中出现过的 screenshot/state tick mismatch 不属于本次失败原因。

## 修复

- 有任务检查点的继续按钮使用现有 startRecoveredContinuation → continueTask → context.prepare → turns.start。
  同一 taskId 保留批准的标准和任务账户；重新检查项目状态，不重放旧工具请求。拒绝失效/已完成检查点、当前执行或待人工 barrier 下的重复继续。
- 每次批准方案、预算或人工恢复的 continuation 都包含有 UTF-8 预算的任务检查点：原始需求摘要、当前修订、未通过标准和证据数量。
  不附加全场景；条目截断/遗漏明确标出，task.evaluate 仍使用宿主冻结的完整标准。
- 正常结束但验收未完成时，在没有真实工具失败、取消、停止或待人工 barrier 的条件下，最多自动补全两次。
  每次继续经过原有 beginTurn、预算与工具审批。未补齐仍 blocked；人工明确继续可开启下一轮有界补全。
- 提示 Agent 通过调用下一步工具触发实际审批，不能以预测未来需要审批为由提前停止；未放宽授权 scope。
- 已结束回合的文字节点立即完成，避免自动继续时旧节点仍显示 streaming。
- 面板显示未通过标准和已保留证据的数量；底层诊断码保持兼容。

## 验证与范围

定向回归 33 项通过，包含真实 Electron 审批跨进程重启、预算继续、工具失败保持、同 tick 重采集、
提前结束后补齐、持久化检查点开启新执行、最多两次补全及上下文字节预算。
测试使用确定性 backend/工具夹具；没有调用用户已登录的远端模型重新生成当前魔方，因此不声称这个游戏已经通过实际交互验收。

总检查通过前置阶段后在旧能力记录失效处停止。正式能力捕获会刷新当前源码绑定；不以此宣称后续全仓阶段全部重跑。
本轮不修改用户当前游戏，不重启正在运行的 AIStudio。构建后重启应用，再对原任务点击继续即可使用新流程。

最终正式能力捕获 143 项通过；详细源码绑定与结果见 capability-verification.json。
