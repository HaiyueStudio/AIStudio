# M13 多工具 Batch、DAG 与有界并发 Scheduler

Implementation binding: `m13-g06-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

G06 允许一次 assistant step 发出多个 Studio 工具调用，同时保持工具注册表、审批、Document History、预算、Session Log 和 Backend result protocol 的既有所有权。并发只减少独立读取 body 的等待时间；它不允许模型提升权限，也不改变 mutation 的串行真值路径。

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

完整 Scheduler 校验唯一 node/tool-call identity、依赖存在性、DAG cycle、并行 class/effect 一致性和冻结合同上限。它把独占节点对前序节点、后序读取对最近屏障的顺序约束加入 effective DAG；因此 forward dependency 与屏障形成的隐式 cycle 会在执行前失败。

Ready queue 使用 rolling pool。独立读取最多按 request 与产品上限中的较小值并行；独占节点等待所有前序 body，执行期间没有其他 body，后续读取等待屏障结束。节点失败默认只取消传递依赖，独立节点继续；`stop-batch` 会中止 active peer 并取消剩余节点。外部取消、节点 timeout、batch wall time 与 output byte 上限都产生有界、可诊断 outcome。

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
