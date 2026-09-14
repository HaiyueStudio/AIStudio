# M12 G10 observation, evaluation and bounded repair loop

## Public Play seam

The model-facing sequence is `preview.validate` → `play.start` → `play.input` / `play.step` → `play.inspect` / `play.capture` → `task.evaluate` → `play.stop`. The older `preview.start` and `preview.stop` names remain compatibility aliases, but a preview-start acknowledgement is never acceptance evidence.

The renderer owns the sandboxed iframe and WebGPU lifecycle. `AgentPreviewBroker` admits one typed command at a time. Every observation is bound to task, turn, Play id, document revision, ordered script digests, simulation tick, display frame, viewport, device preset, timestamp and producer version.

## Persist-before-reference

`PlayObservationRepository` writes state, event trace, runtime error, performance, screenshot, visual analysis and lifecycle envelopes into the Operation Log content-addressed artifact store before an artifact id may enter a tool result. State projections are bounded. PNG bytes are capped at 376 KiB so their base64 envelope stays below the 512 KiB CAS object ceiling; neither tool results nor event payloads contain base64 screenshot data. Each task also has an observation byte quota.

`play.inspect` takes one renderer snapshot and derives four independently addressable artifacts: state, event trace, runtime errors and performance. `play.capture` records PNG evidence. `play.stop` records cleanup lifecycle evidence after the same Play owner has released its scopes.

## Deterministic and visual evaluation

`task.evaluate` consumes `TaskSpecV2` and persisted observation ids and returns `EvaluationResultV2`. It rejects another task, another Play instance, another document revision, another script set, stale current revisions, missing artifacts, integrity failures and screenshot/state tick mismatches.

Agent-visible deterministic assertions use this deliberately small DSL:

```text
evidence <type>
evidence <type> signal <dot.path> equals <json>
evidence <type> signal <dot.path> gte <number>
evidence <type> signal <dot.path> lte <number>
```

A semantic visual assertion must use a `visual-analysis` artifact produced by an independent visual verifier adapter. A screenshot alone proves only capture presence. A backend without image input therefore receives `blocked`, never a fabricated visual pass.

## Task state and bounded repair

`BoundedPlaytestTask` guards `planning → editing → validating → playing → evaluating → repairing`. Completion is legal only after every required acceptance passes with evidence ids. A repair must cite evidence from the latest failed evaluation. The guard hashes repair arguments plus evidence; an identical repeat terminates as `task.repair-no-change-repeat`. Repair count is bounded independently, while the shared task account continues to enforce token, cost, wall-time, turn, tool and observation-byte limits. Repair records retain usage and cost record ids.

A confirmed `play.stop` or `preview.stop` result with `state: stopped` returns an active playing/validating loop to editing. This does not reset repair attempts, evaluation evidence, terminal diagnostics, or approval/revision checks. Editing while a preview is still active reports `task.preview-stop-required`; preparing a script proposal alone does not mutate the running scene. A repeated `play.stop` confirms teardown without inspecting a nonexistent runtime or fabricating another lifecycle observation.

Cancellation, budget exhaustion, renderer crash and device loss transition to a terminal state and can retain lifecycle/error evidence ids. No failure path expands capabilities, approvals or budget.

## Security invariants

- No arbitrary capture path and no screenshot binary in logs or model-facing projection.
- Artifact checksum, task, Play, revision, script-set, tick and viewport provenance fail closed.
- Observation and result sizes are bounded before model access.
- A visual claim blocks without verifier analysis.
- Same arguments plus same evidence cannot consume another repair iteration.
- Stop and renderer teardown remain renderer-owned and release all Play side effects.

### 工具参数修正与验收修复

工具调用失败也会把结构化错误反馈给模型。`summary`、`digest-only` 只压缩业务数据，不丢弃失败的诊断 code、message 和修正指引。方案字段校验指出具体字段与预期类型，保持验收要求不被静默删除。

对于已知未提交的参数错误（`plan.payload-invalid`、`tool.arguments-invalid`）和需要先停止预览的编辑请求（`task.preview-stop-required`），模型先在当前回合修正并提交新的调用。如果模型提前结束回合，Host 在同一任务的 `repairIterations` 预算内续处理，并保留未解决错误。次数记录在任务时间线中，跨回合继续累计；新回合、工具调用仍受原预算控制。修正后的调用继续经过工具校验、项目修订检查及用户审批。

执行图保留失败尝试，后续成功调用单独展示，任务时间线记录“继续修正工具调用”及“工具修正后已完成”。只有实际调用成功才移除相应的未解决错误；这不代表整个任务通过验收。用户取消、待审批、任务终止、未知提交结果、授权错误及无法识别的执行错误不会触发此自动续处理。达到预算后保留原始失败原因，交给用户处理。
