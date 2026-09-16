# W5：等待与持久化优化

实施日期：2026-09-16。沿用 W1–W4 的唯一工具、事务、日志与生命周期路径。

## 实现

- **文本检查点**：AgentTurnRuntime 对相邻、同坐标、同元数据的 streaming text delta 按 250ms / 8KiB UTF-8 聚合审计写入，原始事件仍逐条交给 Host。非文本事件、文本终态、流异常退出和 dispose 会 flush。异步落盘错误会阻止后续控制事实被当成正常成功处理。审计仍只记录文本 digest / bytes，不写原始文本。
- **聊天投影**：内存实时更新；同一文本节点只保留待写的最新快照，使用相同时间和字节阈值。工具与控制事件、终态、显式历史读取和 dispose 强制刷新文本检查点；没有待处理文本时，工具交接不等待其他历史投影写入。完整文本检查点仍通过既有 CAS + `conversation/node-projected` 恢复，项目完整执行记录继续使用原日志。审批、预算、事务、验收与工具结果不参与文本去重。
- **TaskRun**：字段相等的 patch 不增加 revision、不广播、不写 CAS / journal；新增 timeline 事实始终保留。没有对含实际状态变化的任务投影进行时间窗口覆盖，避免丢失恢复边界。
- **独立预览通道**：main 发出专用无载荷 pending 提示，preload 提供受限订阅，renderer 使用独立 single-flight 调度。命令与 ack 继续走既有验证后的 IPC / broker，并保留 commandId 去重、取消和迟到 ack 拒绝。命令响应携带有版本的任务归属投影，避免为启动预览等待完整聊天 replay；旧 replay 不能覆盖更新的预览归属。首轮场景加载完成后即启动该通道；桌面实际打包的 `preload.cjs`、TypeScript 入口和 Web 模式均已接线。监听器和定时器随原生命周期释放。
- **场景刷新**：Host 从实际成功结果的 before/after revision 生成刷新标记，shell 验证并保留该字段；renderer 仅对当前文档中尚未观察、且提交 revision 高于当前编辑器的结果刷新。只读、运行时操作、重复及历史结果不再刷新整场景。人工编辑仍使用原路径。
- **rolling drain**：用 idle waiter 代替 `setTimeout(0)` 轮询。取消立即淘汰未启动节点，等待实际运行的工具退出后才结束 drain；迟到成功不再发布，同步抛错也会结算节点。
- **知识索引**：初始化复用在途工作，active project / asset 源更新串行化；相同项目 owner、文档、revision、manifest 的并发刷新复用已完成检查点。缓存命中前仍校验当前文档，刷新完成后再检查 revision；失败和取消不提交命中标记，后续可重试。检索失败继续使用现有 exact context 降级。

## 持久化与取消边界

250ms / 8KiB 是检查点提交阈值，不是存储设备完成 fsync 的实时保证。异常断电最多恢复到最后一个已完成的文本检查点，未持久化的非关键流式尾部可能丢失；工具、审批、事务和终态保持原耐久性要求。没有全局切换 manual flush，也没有引入第二套 journal。

rolling timeout 仍会发出 AbortSignal，但无法强制终止忽略取消的任意 Promise。此时 drain 会等待实际操作退出，避免把仍在写入的工作当成已经停止。现有 provider 网络退避、审批等待和 exact revision fence 保留。

本次没有额外并行化启动准备，也没有引入 group commit；先通过减少重复写入与独立预览调度消除已确认的等待。

## 回退

可信构造选项 `AgentRuntimePluginOptions.batchTextWrites = false`（产品 profile 同名选项）及 `ConversationHostOptions.batchTextWrites = false` 可分别关闭审计文本聚合与聊天快照聚合。工具执行、模型请求、审批和事务协议不变。完整 TaskRun 事实始终保留，TaskRun 无变化过滤不影响恢复数据。

## 验证

| 确定性 fixture | 结果 |
| --- | --- |
| 100 个相邻小文本 delta 的 runtime 审计 | 100 次文本 append → 1 次聚合 append；边界顺序与完整文本保持 |
| 100 次文本更新随后完成 | 101 个实时聊天事件，2 个持久化聊天投影；重载恢复完整文本和终态 |
| 100 次相同 TaskRun patch | 1 次 revision / 通知 / 持久化；额外 timeline 事实仍落盘 |
| 20 个同 revision 的并发索引刷新 | 1 次 project upsert + 1 次空 asset tombstone |
| Electron 中挂起聊天 replay | 预览 inspect 在 replay 释放前完成 ack |
| Electron 编辑器刷新 | 只读 / 重复 / 旧 revision / 外部文档均为 false，仅新提交为 true |

以上是受控 fixture 的写入次数与行为结果，不代表真实模型 token、费用或整任务延迟降幅。

验证还覆盖定时和字节检查点、写失败、dispose 刷新、实际工具退出、取消迟到结果、项目切换、审批退出和原始结果恢复。

最终验证：

- W5 专项 **9/9** 通过；真实产品、独立预览通道和打包安全专项 **3/3** 通过；审批/预算恢复 **18/18** 通过。
- 能力验证 **18 组、344 项** 全部通过，生成的 census / verification 已绑定当前源码。
- `TMPDIR=/private/tmp npm run check` 已运行到底：合同、类型、包边界、上游与候选包、59 项 quick、19 项文档、34 项行为、5 项工作区、185 项 Agent 工具、23 项逻辑测试通过。
- 完整集成 **67/67 个文件，355 passed / 6 failed / 0 skipped / 0 cancelled**；9 项 W5 新增测试在集成中全部通过。生成物 secret scan 通过（该轮扫描 654 个文件）。**完整 check 仍未通过。**

剩余失败分布在与 W4 相同的 5 个测试文件中；不能据此断言所有失败根因完全相同：

| 测试 | 本轮失败 |
| --- | --- |
| `g10-agent-integration.test.mjs` | 1 项仍断言旧文案 `Inspect this before planning` |
| `m14-g08-adapter-review/adapter-device.test.mjs` | 2 项 PNG 尺寸断言：实际 240，预期 480 |
| `m14-integration/product-electron.test.mjs` | 1 项原生窗口 `window.focus()` 后等待 `window.isFocused()` 超时；独立复验同样失败。W4 此文件曾失败于硬编码平台/CPU 断言，本轮没有走到该位置，未认定二者是同一根因 |
| `material-cursor-electron.test.mjs` | 1 项 author 初始化读取 undefined 的 `[0]` |
| `plan-review-electron.test.mjs` | 1 项 renderer script 执行失败，底层异常仍未定位 |

本轮同时修正了知识源测试固定“七条指南”的过时数量断言，按实际受审引擎文档清单核对；该测试现已通过。未修改其余失败断言、未跳过测试、未推进 milestone。

日志：`/tmp/aistudio-w5-last-focused.log`、`/tmp/aistudio-w5-product-regression.log`、`/tmp/aistudio-w5-barrier-electron.log`、`/tmp/aistudio-w5-capture-verified.log`、`/tmp/aistudio-w5-check-verified.log`、`/tmp/aistudio-w5-product-isolated.log`。完整集成产物保存在 `/private/tmp/aistudio-w5-integration-evidence`；仓库内被测试覆盖的已跟踪 `test-output` 已恢复，源码和能力证据保留。
