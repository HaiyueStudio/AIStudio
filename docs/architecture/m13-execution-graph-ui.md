# M13 Execution Graph product UI

Implementation binding: `m13-g09-2026-09-02`

The Execution Graph is a renderer-safe projection of the durable Agent Session. It is not a scheduler, task store, approval owner, accounting ledger, or second conversation history.

## Ownership

1. `SessionOpV1` and content-addressed artifacts remain the append-only execution truth.
2. `projectExecutionGraph` deterministically derives graph nodes, causal edges, the complete human Transcript, context pressure, compaction history, diagnostics, and a semantic SHA-256 digest.
3. `StudioConversationHost` owns Session replay and emits validated graph read models. It debounces live projection work but can rebuild the same digest after main-process restart.
4. The renderer stores only session selection, graph/Transcript mode, selected node, query, filter, detail level, and zoom in a `WeakMap`. Refresh never restores business state from renderer memory.
5. Layout coordinates are calculated separately and are excluded from the semantic digest.

## Projection and failure behavior

- Tool batches, tools, transactions, approvals, questions, compactions, evidence, evaluations, retries, recovery, and results use stable Session coordinates.
- `parallel-with` is emitted only for recorded overlapping tool intervals in the same batch. Timestamp proximity is never treated as causality.
- Modification and validation edges come from transaction/evidence identities and artifact provenance.
- Sequence gaps, dangling references, unsupported operation kinds, unknown cost, and missing evidence remain visible diagnostics. Unknown values never become zero or success.
- Completed low-information read tools may be reduced in overview layout, while waiting, failed, outcome-unknown, critical, Transcript-linked, and barrier nodes stay visible.

## Transcript and compaction

The Transcript is rebuilt from durable message artifacts plus human-relevant system operations. Surface replacement never deletes message artifacts or Transcript items. Automatic and manual compaction appear as graph nodes and Transcript entries with before/after pressure, covered range, validation, and summary artifact identity.

The renderer emits only `conversation/request-compaction` with stable `sessionId` and `requestId`. The host verifies a safe boundary, uses the model-aware Backend binding and Studio fallback summarizer, then lets `ContextCompactionRuntime` atomically publish the replacement Surface. Completed request identities are checked in the durable operation log, so reload or process restart cannot repeat the same request.

Context Frames are captured once per real turn after a Backend Session binding exists. Their authoritative pressure payload is projected directly; the renderer does not estimate token capacity.

## Product interaction

- Graph and complete Transcript are peer tabs with bidirectional locating.
- Search and filters cover current, waiting, failed, modifications, validation, compaction, approval, and cost unknown.
- Node details expose duration, revision range, tool/version, execution class, transaction, diagnostics, artifact refs, and usage/cost record ids without preloading artifact bodies.
- Arrow keys and Home navigate the deterministic layout. Zoom has button alternatives, reduced-motion CSS is honored, and a complete hierarchy list is available to assistive technology.
- The message composer stays editable while a task or durable barrier is busy; only the send action is gated by backend/task readiness.

## Performance boundary

The pure projector and deterministic layout are covered by a 1000-tool fixture. Overview keeps fewer than 100 nodes while preserving exceptional nodes. Current browser candidate measurements and screenshot provenance are recorded in `docs/evidence/m13-g09-browser-evidence.json`; the formal Electron gate remains distinct from this browser candidate.

## Concrete node content (2026-09-14)

Model rounds display public assistant commentary, actual requested tools, and their recorded outcomes. The host appends only the new public text at each model-to-tool boundary and at turn completion; streaming updates use the current redacted projection without a durable write per token. The exact message operation assigns text to its model round. This does not capture hidden reasoning or invent an explanation when the provider supplied none. Historical records lacking commentary explicitly remain unavailable.

The headless content projector joins tool summaries by session, turn, and tool-call identity. Plan/question/approval text uses the exact recorded barrier identity; transactions and evidence use recorded modification/validation edges. Task summaries stay within task membership even when multiple tasks reuse a session. It never loads raw scripts, tool parameters, or artifact bodies into node details. Model explanation, action, and result fields are bounded to 2048 characters, and old projections without these optional fields still render.

Details omit absent technical fields and label public model text separately from execution facts. Long hover panels choose a non-overlapping placement or a scrollable height so they cannot cover the trigger and intercept click/drag input.

### 详情中的段落与 Markdown

执行节点详情和完整记录复用 `panels/markdown.ts` 的只读 DOM 渲染组件。支持段落/换行、标题、有序与无序列表（含嵌套）、引用、强调及行内/围栏代码；不使用 innerHTML，不执行 HTML，也不自动加载模型提供的媒体或链接。详情仍遵守既有文本长度限制。

公开模型说明保留原始段落；执行内容与结果按子节点名称分组，以空行分隔。紧凑节点摘要保持原有布局，详细内容在弹出面板内滚动阅读。历史记录没有保存的段落边界不会从分号中猜测恢复，以免改坏代码和原文。
