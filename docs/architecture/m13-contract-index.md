# M13 Session/Surface contract index

Binding: `m13-g01-2026-09-01`

M13 uses one provider-neutral contract owner: `packages/studio-contracts/src/m13.ts`. JSON Schema is the untrusted-input boundary; TypeScript types are the compile-time view. Neither is a runtime implementation.

## Top-level envelopes

| Contract | Write owner | Main consumers | Migration rule |
| --- | --- | --- | --- |
| `AgentSessionV1` | G02 Session runtime | G03, G04, G09, G11 | Reject versions other than 1; never infer a remote provider session as product truth. |
| `SessionOpV1` | G02 Operation Log adapter | G03, G06, G09, G11 | Append only; sequence gaps stop replay. |
| `ModelSurfaceV1` | G02 Surface projector | G03, G04, G09 | Replace creates a new generation; it cannot rewrite SessionOp or Transcript. |
| `ContextFrameV1` | G03 Context router | G04, G05, G10, G11 | Immutable per request; unknown model capacity blocks automatic compaction. |
| `ToolBatchRequestV1` | G06 Scheduler | G07, G08, G09, G11 | Validate DAG and effects before dispatch; unknown effects become exclusive. |
| `SceneDiffV1` | G05 Document projection | G08, G09, G10, G11 | Exact adjacent revision range or an explicit cursor; a gap requires a bounded snapshot. |
| `ExecutionGraphV1` | G09 projection | G11 and M14 shared graph UI | Projection only; every node and edge is traceable to SessionOp/artifact refs. |
| `KnowledgeHitV1` | G10 retrieval | G11 | Stale/untrusted hits are diagnostics, never exact Scene truth. |

Nested types (`BackendSessionBindingV1`, `SessionCheckpointV1`, `SurfaceOpV1`, `ContextPressureV1`, `CompactionRecordV1`, `ToolBatchNodeV1`) migrate with their containing top-level envelope. A later Goal cannot create a parallel backend-specific envelope.

## Owner boundaries

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Studio Session runtime | session identity/status, Surface generation, checkpoints, provider bindings | provider private messages or hidden reasoning |
| Backend adapter | remote session lifecycle, wire translation, usage/cache capability negotiation | durable Studio history, budget truth, UI state |
| Operation Log | ordered SessionOp and content-addressed artifacts | mutable Scene undo/redo state |
| Document History | atomic Scene mutation, revision and inverse operation | agent conversation or provider session |
| Context router | immutable ContextFrame selection, exact/delta routing, pressure measurement | deleting log history or guessing missing capacity |
| Scheduler | DAG validation, effect classification, bounded dispatch, unknown-outcome quarantine | bypassing approval, budget, permission or Document History |
| UI projector | Transcript and Execution Graph projections | synthesizing completion not present in durable ops/evidence |

The full machine-readable registry is `config/contracts/m13-contract-index.json`. Diagnostic vocabulary is closed in `M13DiagnosticCode`/`M13DiagnosticV1`; session and graph status use `AgentSessionStatusV1` and `ExecutionGraphNodeStatusV1`; scheduler effects use `ToolEffectV1` plus `ToolExecutionClassV1`; graph topology uses `ExecutionGraphNodeKindV1` and `ExecutionGraphEdgeKindV1`. Unknown values from untrusted input are rejected until a versioned contract adds them.

## Handoff gates

G02 may start only after the Session/Surface schemas, append-only and replay rules, reload/reconnect failure rules and semantic fixtures pass. G05 may start only after `SceneDiffV1` includes entity, component, script, asset, camera, render, tombstone, provenance and cursor fields, and the 1000 Entity/200 Script baseline is reproducible.
