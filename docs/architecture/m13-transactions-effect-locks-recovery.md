# M13 G07 transactions, effect locks and recovery

Implementation binding: `m13-g07-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

G07 adds one mutation commit owner beneath the G06 rolling batch scheduler. The model still requests ordinary registered tools. The Conversation Host prepares consecutive reversible mutations against one frozen document revision, and the Game Authoring Tool runtime converts those preparations into a single `SceneTransactionCoordinator` commit. The Project Workspace is the only component allowed to apply the operation list to the document and History.

## Transaction boundary

`prepare` validates member count, stable identities, tool versions, effect keys, operation bounds, document identity and exact base revision. It computes deterministic transaction, idempotency, command, member and operation identities without mutating the document.

`commit` acquires the union of registry-derived effect keys plus the document revision gate, then calls `ProjectWorkspace.executeTransaction` once. Workspace applies the ordered operations through one History command. A successful transaction therefore creates one document revision and one undoable History entry, regardless of whether it contains 2, 7 or 100 tool members.

The durable receipt is written as a content-addressed artifact immediately after the History write and before the acknowledgement event. The same boundary stores the exact `GameDocumentDeltaV2` as a content-addressed Scene diff result. The receipt binds:

- transaction, idempotency and command identity;
- project/document and before/base/after revision;
- ordered operation digest and ordered member digest;
- History entry id and label;
- commit timestamp and receipt digest.
- the Scene diff transaction identity, Scene diff artifact and retained result-artifact ids.

Replaying the same transaction returns the receipt and never submits another History command. The ledger also rejects reuse of one committed idempotency key under a different transaction id. A corrupt receipt, missing receipt reference, missing Scene diff artifact or mismatched delta fails closed. If commit acknowledgement is lost, the coordinator queries the receipt. A matching receipt synthesizes success; unchanged revision proves not committed; an advanced revision without a unique matching receipt becomes outcome unknown. Undo and redo append their own deltas while the original receipt and Scene diff remain immutable and discoverable.

## Effect locks

`EffectLockManager` owns fair, cancellable, multi-key leases. Keys are canonicalized and sorted before acquisition. A request never holds a partial key set while waiting, which prevents lock-order deadlocks. Earlier conflicting waiters retain FIFO priority, while disjoint owners may overlap.

Tool execution classes are converted to safe lock scopes by registry-owned classification:

| Execution class | Lock policy |
| --- | --- |
| parallel read | no write lease |
| reversible mutation | entity/component/script keys plus document revision gate |
| runtime barrier | runtime identity, with runtime fallback |
| trusted/approval barrier | scoped key plus document gate |
| unknown exclusive | global effect key |

Leases are deliberately process-local. No lease is treated as recovery truth. After restart, Session intent and the Workspace receipt/History/revision authority decide what happened.

## Durable barriers

Plan review, tool approval, backend questions and budget continuation are persisted as Session request operations followed by a Session checkpoint before they become actionable in the renderer. Their `expiresAt` is null. A resolution is appended and checkpointed before execution resumes.

Conversation projection restoration reopens the Session without generic crash repair, runs G07 reconciliation, and preserves a pending node only when its barrier id remains unresolved in the durable Session. Approval, plan and question actions therefore remain valid after renderer reload or Electron restart. The composer is not disabled by an active task or a pending barrier; a new message is durably queued and can supersede a live wait without discarding committed output.

Every waiting barrier now releases the provider request as well as renderer ownership. Plan review, tool approval, backend questions and budget continuation return a bounded `barrier.waiting-user` result where applicable, cancel the old provider turn, and record `conversation/barrier-provider-released` with zero active calls. Resolution starts a fresh bounded turn from the durable checkpoint; it never revives the old JavaScript/provider stack. Harness and Codex retain their native cancellation semantics at the adapter boundary, while the Host barrier state machine remains provider-neutral.

## Recovery decisions

`DurableSessionRecoveryCoordinator` serializes recovery ownership per Session and appends a durable claim/epoch fact. It classifies open work deterministically:

- each streamed node is durably projected as a versioned `tool-batch.planned` record before `tool.started`; a crash in that window becomes `retry-not-started` and is preserved in the interrupted batch's resumable node list;
- interrupted reads are bounded retry candidates;
- a mutation with a matching receipt is synthesized as `document.committed` plus `tool.completed`;
- an unchanged base revision is retryable but is not automatically committed by recovery;
- an advanced revision without a matching receipt creates a non-expiring manual takeover barrier;
- when the transaction identity did not reach Session, bounded member-node receipt discovery closes the receipt-before-Session crash window.
- if `document.committed` already reached Session but `tool.completed`/checkpoint did not, recovery reuses that exact commit projection and only synthesizes the missing tool completion.

Recovery ownership is fenced twice. An in-process tail serializes callers in one Host, while an atomic per-Session claim directory fences separate Electron processes. A live PID makes contenders defer; after the owner exits, a new process validates and takes over the orphaned claim. Transaction idempotency and the Workspace commit serializer remain the final at-most-once boundary.

## Product evidence and accounting retention

TaskRun evidence metadata, screenshot previews and the normalized accounting read model are durable projections. Each accounting update stores a content-addressed `conversation-task-accounting/1` artifact referenced by `agent/task-accounting`; restart restoration uses the same product validator as renderer IPC. A user budget stop therefore changes task status without deleting the committed transaction receipt, generated artifacts, state/screenshot evidence, evaluator acceptance results, usage or cost. A queued evaluator repair cannot outrun a newly opened durable budget barrier.

## Metrics

`SceneTransactionCoordinator.snapshot()` exposes bounded counters and cumulative milliseconds for prepare, commit, reconcile and lock wait, plus stale revisions, ambiguous outcomes and duplicate commits prevented. `EffectLockManager.snapshot()` supplies held/waiting owners, acquisitions, conflicts and cancelled waits. Per-attempt events carry the phase latency and transaction identity; recovery/barrier events carry the classification, claim and provider-release result so aggregate telemetry can be rebuilt from the Operation Log.

## Ownership and data flow

```text
model tool requests
      |
Conversation Host (plan, prepare, barrier, ordered provider results)
      |
Game Tool Runtime (registry policy, member operations, effect keys)
      |
SceneTransactionCoordinator (lock union, commit/reconcile)
      |
ProjectWorkspace (revision CAS, one History command, receipt artifact)
      |
Session + Operation Log (checkpoint, commit fact, recovery decision)
```

Formal verification is `npm run m13:g07:check`. The machine-readable fault matrix is `docs/evidence/m13-g07-recovery-matrix.json`.
