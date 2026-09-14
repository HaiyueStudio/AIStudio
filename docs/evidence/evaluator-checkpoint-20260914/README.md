# Evaluator checkpoint and incremental verification

2026-09-14. Investigation uses the current project's retained local journal; no credentials, raw provider reasoning or project script source is copied here. User's active application/project is not restarted or edited.

## Observed failure and latency

The click-color request ran 13:32:05–13:48:08 UTC (about 16 minutes). The journal contains 13 backend execution turns across 7 sessions, 12 project.snapshot results, 12 tool.search results, 9 play.start results (including suspended/deferred calls), 6 pointer gestures and 5 committed task.evaluate results before the final failed attempt. Approval/question requested-to-resolved intervals total about 126 seconds, including automatic grant reuse; these intervals are not additive with tool durations. The task is not a 16-minute script execution.

The first successful evaluator invocation found six missing signal paths out of seven criteria: authored geometry/material/pointer fields absent from runtime state, an invented events array, and gesture effects returned to the model but not persisted in the evaluator's state artifact. Three other evaluation attempts supplied invalid criterion/evidence mappings. Repeating Play could not fix these failures. The final task.evaluate request occurred after a hard budget overrun, with no tool/execution-started event. The host's checkpoint result had a non-null diagnostic value and was passed unconditionally into evaluationResult, throwing `task.evaluation-invalid` before the normal budget continuation handling. Failed/cancelled tool values are not evaluation envelopes.

## Changes

- Only completed tool bodies feed product evaluation/evidence. Preserve authoritative completed results even when model-facing output hits its byte cap.
- Persist gesture effects derived from actual before/after engine entity/material/camera state, plus bounded input events across settle ticks. Preserve baseline evidence in the task projection as well as final evidence.
- Reject known unavailable reserved Play paths during plan validation with concrete producer guidance. Restored plans missing those fields block with `evaluation.signal-unavailable`, rather than consuming gameplay repair attempts. Actual failed conditions and dynamic gameplay fields keep their existing semantics.
- Evidence selection errors include the invalid mapping and are eligible for bounded argument correction with existing evidence. Provenance, budget, approval and task identity checks remain in force.
- Continuation context contains bounded, current-revision, same-Play evidence references and routes gesture predicates to their producer. Explicitly named next tools receive registered schemas ahead of fuzzy matches within the existing schema count limit.
- Updated searchable data-first verification documentation. A color factor delta proves the tested material changed; it does not prove random distribution or rendered visual correctness.

## Verification

- Focused host/plan/continuation/evaluator/tool runtime suite: 101 passing tests.
- Additional baseline retention, mixed unavailable/failed criteria and tool-selection suite: 11 passing tests (includes existing regression checks).
- Tools, orchestration and desktop app builds run separately.
- Root `npm run check` passed earlier gates, then stopped at the existing M14 capability census `stale verification input binding`; no baseline was recaptured to conceal the failure.
- No paid/live model rerun was performed. End-to-end time reduction must be measured on the next real task; no speedup ratio is claimed. Historical failed records are preserved, not rewritten as success.
