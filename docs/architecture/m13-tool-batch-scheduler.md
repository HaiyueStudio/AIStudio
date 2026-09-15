# M13 多工具 Batch、DAG 与有界并发 Scheduler

Implementation binding: `m13-g06-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

G06 允许一次 assistant step 发出多个 Studio 工具调用，同时保持工具注册表、审批、Document History、预算、Session Log 和 Backend result protocol 的既有所有权。并发减少独立 body 的等待时间；它不允许模型提升权限，也不改变 mutation 的串行真值路径。

## Data flow

```text
Backend tool-request stream
        │ legacy single call / consecutive calls
        ▼
ToolBatch normalization
  ordered node ids + explicit dependencies + bounded limits
        │
        ▼
Registry-owned classifier
  definition.effect + requiresApproval + concurrencySafe + bounded args
        │
        ├─ parallel-read ───────────────┐
        └─ mutation / approval /        │ rolling pool (max 4)
           runtime / trusted / unknown ─┤ exclusive barrier
                                       ▼
                              concurrent tool bodies
                                       │ out-of-order completion allowed
                                       ▼
                           ordered commit chain by call order
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
Backend.submitToolResult      AgentTurn usage/cost refs      durable SessionOp + UI
```

`ToolBatchRequestV1` 和 `ToolBatchNodeV1` 继续使用 G01 冻结合同。旧 Backend 不需要新增事件类型：连续的 `tool-request` 被规范化为一个 rolling batch；只发一个调用的 Harness 仍形成单节点 batch，并在结果提交后继续原 generator。显式完整 DAG 可直接交给 `ToolBatchScheduler`；流式兼容层只接受指向已出现节点的依赖，避免尚未到达的 forward dependency 让 provider 死锁。

## Trusted classification

模型提供的 effect、risk、approval 或 execution class 都不会进入分类输入。`classifyToolConcurrency` 只读取已注册 `GameToolDefinition` 和经过边界限制的参数：

- `observe + concurrencySafe=true` 才是 `parallel-read`；
- Document edit 为 `exclusive-mutation` 或 `approval-barrier`；
- script propose/apply 为 `trusted-code-barrier`；
- Preview/Play validate/start/stop/step/input/inspect/capture 为 `runtime-barrier`，即使旧工具 effect 名为 observe；
- 工具缺失、声明异常或未明确安全时一律 `unknown-exclusive`。

每个注册工具现在都暴露显式 `concurrencySafe`。安全集合只含 immutable project/scene/diff/component/camera/entity/script/diagnostic/asset/evaluator observations；Play state 和所有可变路径都不在集合内。参数中的 entity/component/script/asset/proposal/plan identity 被投影为 effect keys，供后续 G07 effect lock 使用，但 G06 不据此并行 mutation。

## Scheduling and failure semantics

完整 Scheduler 校验唯一 node/tool-call identity、依赖存在性、DAG cycle、并行 class/effect 一致性和冻结合同上限。它把需要串行的节点对之间的顺序约束加入 effective DAG；因此 forward dependency 与屏障形成的隐式 cycle 会在执行前失败。

Ready queue 使用 rolling pool。独立读取最多按 request 与产品上限中的较小值并行；普通场景编辑与依赖项目状态的读取保持串行；只有经过固定白名单审计、未声明 revision 约束的 engine.docs.search/read、tool.search、component.describe 可以与 exclusive-mutation 重叠。这些工具读取固定文档/注册表，不能用于证明场景状态。审批、trusted-code、runtime 和未知 effect 仍是完整屏障。节点失败默认只取消传递依赖，独立节点继续；`stop-batch` 会中止 active peer 并取消剩余节点。外部取消、节点 timeout、batch wall time 与 output byte 上限都产生有界、可诊断 outcome。

只有 dispatch/body 允许重叠。结果 projection、Backend submit、usage reconciliation、cost attribution、`tool.completed` SessionOp 和 Conversation projection 通过 call-order commit chain 串行执行。实时 completion ordinal 只用于诊断，不进入 stable result digest；相同输入和结果重复执行产生相同 digest。

## Durable operations and accounting

每个产品 batch 写入：

1. `tool-batch.planned`，包含 PTC 协议和有效 limits；
2. `tool-batch.started`；
3. 每节点 `tool.started`；
4. 按调用顺序写入 `tool.completed`，携带 latency、model-facing output bytes、result digest、UsageRecord ref 和 CostRecord ref；
5. `tool-batch.completed`，携带计数、墙钟、总输出和稳定 digest。

当前 provider Token 和价格仍按 turn 结算，所以节点 CostRecord 使用可审计的 `turn-shared` 归因，而不是伪造 Token 拆分；工具 input/output bytes 和 toolCallId 由 Usage ledger 精确归属于节点。若 provider result delivery 失败，Host 写 `tool.outcome-unknown` 并取消 turn，不把未确认提交伪装成成功重试。

## Turn protocol and bounds

通用、类型无关的 Prompt workflow 是 `Plan → Tool batch → Check`：先形成用户可读方案；一次 assistant step 尽量合并独立 observations；每批之后读取权威结果再决定下一批。默认产品上限是 64 nodes、并发 4、60 秒、1 MiB model-facing output 和 3 repair rounds。单工具定义仍可施加更低 timeout/result 上限；不允许通过 batch 放宽。

## Boundaries

- Scheduler 位于 Game Authoring Tools，保持 provider-neutral，不读取 Editor、DOM、GPU、网络、Shell 或项目外文件。
- Conversation Host 只负责产品组合、审批/预算交互、Backend result 和 Session/UI 投影。
- Mutation 仍通过现有 prepare/approve/execute 与 Document History；G06 没有创建第二条写路径。
- G07 才增加跨崩溃 effect lock、transaction recovery 和 outcome-unknown 接管；G09 才把这些 SessionOp 投影为完整 Execution Graph UI。

## Independent documentation and scene work (2026-09-15)

计划批准后的执行指引要求模型在同一轮提交独立工具调用。例如把创建灯光与创建基础几何体的低风险 `entity.create` 放在一起，由 Host 合并为一个 Document transaction，同时检索脚本所需的固定 API 文档。`entity.create-many` 仍可用于显式批量创建，但保留其 medium-risk scoped approval barrier，不因为并发降级权限。重复组合模型继续使用 assembly/prefab，共享几何和材质。

返回新对象 ID、搜索结果引用、文档内容后，再进行依赖它们的脚本修改；运行预览仍需等待场景和脚本提交。模型每轮只生成一个调用时，调度器不能预测未来调用，也不会自动增加模型请求。

Host 分离事务提交等待与固定注册表读取。所有后继的场景读取/编辑都捕获上一事务的 completion promise（不能只让紧邻事务的第一个读取等待）；固定读取可先执行，结果交付、日志和计费仍按源顺序提交。事务开始 flush 时封闭成员，后续流式调用不能加入已经提交的事务。旧 revision 的写入仍拒绝，不自动 rebase。

Runtime 仅允许同一 Document 内固定读取跨越 revision 变化。项目切换、显式 revision 约束、stateful reads、审批和参数 digest 校验不豁免。注册表读取中途切换项目也拒绝返回错误项目归属的结果。
