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

Cancellation, budget exhaustion, renderer crash and device loss transition to a terminal state and can retain lifecycle/error evidence ids. No failure path expands capabilities, approvals or budget.

## Security invariants

- No arbitrary capture path and no screenshot binary in logs or model-facing projection.
- Artifact checksum, task, Play, revision, script-set, tick and viewport provenance fail closed.
- Observation and result sizes are bounded before model access.
- A visual claim blocks without verifier analysis.
- Same arguments plus same evidence cannot consume another repair iteration.
- Stop and renderer teardown remain renderer-owned and release all Play side effects.
