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
