# M13 durable Session and Model Surface runtime

Implementation binding: `m13-g02-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

G02 implements the G01 provider-neutral contracts in `agent-runtime/src/session`. It does not introduce a second file store: Operation Log owns checksummed journal bytes, CAS artifacts, redaction, flush and recovery; `DurableSessionRuntime` owns Session semantics and projections.

## Stable API

`DurableSessionRuntime` is exported by `@haiyue/ai-studio-agent-runtime` and exposed as `AgentRuntimeService.sessions`. It supports:

- `create` and `open` returning a disposable Session handle;
- serialized `append` and `appendMessage`;
- `replaceSurface`, `bindBackend` and stable `checkpoint`;
- pure prefix `replay` and content-addressed `fork`;
- `flush` and idempotent `dispose`.

The runtime enters `disposing` before it waits for pending appends, so late calls cannot write after teardown. The plugin attempts both Session and backend teardown and aggregates failures rather than leaking the second owner.

## Durable representation

Each `SessionOpV1` is one `agent/session-op` Operation Log event from `studio.agent-session`. The event id equals the op id; session/turn/step correlation and artifact refs must exactly match the embedded operation. The op payload digest is recomputed after redaction and every referenced CAS artifact is integrity-checked on append and replay.

Replay scans only bounded global sequence windows beginning at `OperationLogStatus.retainedFromSequence`. It rejects a missing root, gap, duplicate op/id, unknown Studio Session event, unsupported operation version/kind, invalid parent/dependency, artifact drift, corrupt seed and invalid lifecycle coordinate. Other Operation Log sources sharing the correlation are ignored and cannot become Session truth.

## Model Surface and Transcript

An append operation adds one node whose sole source is the current Session op. A replace operation must name a continuous current range and exactly equal the union of that range's original source ops. It creates a new generation and deterministic digest.

Transcript is an independent append-origin projection of user and assistant message artifacts. Replace never deletes or rewrites Transcript entries. Therefore repeated compaction changes only future model input while renderer reload can still rebuild the complete human history.

Fork stores a content-addressed seed containing the validated parent Surface and append-origin Transcript references at an exact prefix. The child receives no Backend binding, provider session or mutable UI state. Subsequent child and parent operations diverge independently.

## Checkpoint and crash recovery

A checkpoint digest covers its Session boundary, latest turn/batch/document revision, Surface generation/digest and exact unresolved barriers. Replay recomputes these fields before accepting the checkpoint.

On `open`, an incomplete effectful tool becomes `tool.outcome-unknown` with `retryAllowed=false`; its batch/turn are interrupted and a checkpoint is appended. No tool call is replayed automatically. A durable approval or question remains an unresolved barrier and is not converted into a crash failure, so a user may return after renderer/process reload and resolve it later.

G03 will own automatic/manual compaction policy, G04 provider binding/reconnect, and G06 batch scheduling. G02 only supplies their durable Session/Surface foundation.

