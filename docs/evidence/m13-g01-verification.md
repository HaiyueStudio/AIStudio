# M13 G01 verification

Binding: `m13-g01-2026-09-01`

The G01 gate is `npm run m13:g01:check`. It verifies:

- all eight top-level JSON Schemas load under strict AJV and round-trip their valid fixtures;
- unknown versions/fields and secret-bearing payloads fail closed;
- semantic fixtures reject dependency cycles, incomplete Surface replace ranges, digest mismatch, orphan graph edges, reverse revision ranges and invalid knowledge chunks;
- the TypeScript owner exports every indexed top-level and nested type without provider imports;
- the checked-in baseline is byte-for-byte reproducible from reviewed local inputs and covers seven genres plus the 1000 Entity/200 Script corpus;
- architecture/failure/ADR documents carry the same evidence binding and assign one write owner per domain.

Passing this gate means G02 and G05 have stable inputs. It does not claim those runtimes, compaction, parallel scheduling, RAG or the 14-case real-network matrix are implemented.

## Requirement audit

| G01 requirement | Result | Evidence |
| --- | --- | --- |
| Versioned Session/Surface/Context/Compaction/Batch/Diff/Graph/RAG contracts | pass | 8 indexed schemas plus exported nested types in `m13.ts` |
| Closed diagnostic, session/graph status, effect, execution-class and edge vocabulary | pass | `M13DiagnosticCode`, `AgentSessionStatusV1`, `ExecutionGraphNodeStatusV1`, `ToolEffectV1`, `ToolExecutionClassV1`, `ExecutionGraphEdgeKindV1` |
| Studio/Backend/Operation Log/Document History/UI owner split | pass | `m13-contract-index.md` and ADR 0083 |
| Compaction, concurrency, unknown outcome, long approval, renderer reload and reconnect model | pass | `m13-session-surface-failure-model.md` |
| Seven genres and model turn/token/cache/cost/tool/wall metrics | pass-with-unknowns | runner records 2 observed failures and preserves unavailable data as null for 5 genres |
| 1000 Entity/200 Script, snapshot/diff and context-growth baseline | pass | deterministic baseline JSON and `--check` |
| Round-trip, unknown version/field, secret, DAG, effect fallback, Surface range/digest and graph/diff fixtures | pass | generic contract gate plus 7 semantic-invalid cases |
| G02/G05 handoff and status discipline | pass | only G02 and G05 are `ready`; downstream goals remain `draft` |
