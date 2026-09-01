# M13 Session, Surface and tool execution failure model

Binding: `m13-g01-2026-09-01`

This document freezes failure behavior, not its production implementation. The invariant is that renderer lifetime, provider lifetime and project mutation lifetime are independent.

## Durable boundaries

1. A `SessionOpV1` is acknowledged only after append succeeds. Sequence gaps stop projection with `session.sequence-gap`.
2. A mutation is committed only by one Document History transaction. The matching SessionOp points at its revision and artifact; it does not become a second undo owner.
3. A tool result is confirmed only after its durable completion op/checkpoint. Disconnect after dispatch but before confirmation becomes `tool.outcome-unknown`; automatic retry is forbidden for mutation/effectful calls.
4. A Surface generation becomes readable only after its summary artifact, replace operation and digest validate together. Failed compaction keeps the prior generation readable.
5. Approval/question barriers are durable records. Waiting never relies on an open renderer call stack or wall-clock timer owned by a dialog.

## Failure matrix

| Failure | Persist before risky step | Recovery | Fail-closed behavior |
| --- | --- | --- | --- |
| 80% automatic compaction | request/start ops, source generation, pressure, covered sequence range, pinned facts | validate summary then atomically publish target generation and completion op | unknown capacity or invalid summary retains old Surface and emits `context.compaction-unsafe`/`context.compaction-summary-invalid` |
| Manual compaction | same record with reason `manual` | idempotent resume by compaction id | cannot overlap an active compaction or discard unresolved barriers |
| Parallel-tool-batch reads | validated DAG, call ids, dependencies and result byte limit | replay completed nodes, dispatch only unconfirmed safe reads | missing effect metadata maps to `unknown-exclusive`; no speculative mutation |
| Unknown-tool-outcome in mutation/barrier batch | expected revision, effect keys, approval and checkpoint | resume at first unconfirmed node after re-reading revision | revision drift stops batch; mutation with unknown outcome is quarantined for inspection |
| Backend reconnect/disconnect | backend binding generation and last confirmed op | attach a new binding generation; reconcile remote boundary against Studio checkpoint | remote history cannot overwrite Session Log; mismatch becomes stale/detached |
| Renderer reload/crash | no special renderer-owned truth | rebuild Transcript, Surface and graph from SessionOp/checkpoint; re-show pending barriers | text input remains available unless a durable barrier explicitly gates the task |
| Long approval/user absence | approval op, continuation token/artifact, already-created project revision | user resolves at any later time; scheduler starts a new continuation | no hard wall-time failure while merely waiting; decline preserves prior artifacts |
| Process crash during append | CAS artifact before referencing op | orphan CAS is collectible; replay stops at last complete op | never invent the missing op or treat a partial append as complete |
| Scene diff revision gap | requested base/target revisions and cursor | bounded snapshot plus a new exact baseline revision | emit `scene-diff.revision-gap`; do not concatenate incompatible deltas |
| Execution graph projection fault | through-sequence and digest | rebuild projection from ops | orphan edges are rejected; graph never becomes the truth source |

## Compaction thresholds

`ContextPressureV1.ratio` is computed against usable input capacity: `(usedInputTokens) / (maxInputTokens - reservedOutputTokens - reservedSafetyTokens)`. G03 owns the exact hysteresis, with 80% as the default prepare/compact boundary. If capacity or usage is unavailable, ratio is `null`, state is `unknown`, and the system may ask the provider to compact only when that provider action is mirrored as a Studio `CompactionRecordV1`. It must not pretend an arbitrary byte limit is a model token limit.

## Surface replace validation

A replace references one contiguous range from the current generation. The range's complete source op set must equal `sourceOpIds`; the replacement node records the same set and points at the validated summary artifact. The target digest is computed after projection. Missing nodes, reordered endpoints, incomplete source ids or digest mismatch leave the source generation active.

## Recovery acceptance owned by later Goals

G02 proves reload/replay and stable checkpoints; G03 proves manual/automatic compaction; G04 proves reconnect/native compaction mirroring; G06/G07 prove DAG, effect locks and unknown outcomes; G09 proves lossless Transcript/graph rebuild; G11 repeats all failures against both backends. G01 supplies the contracts and repeatable old-architecture baseline only.
