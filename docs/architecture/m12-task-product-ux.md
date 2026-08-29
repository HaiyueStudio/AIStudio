# M12 G11 task orchestrator product UX

## Authority boundary

`StudioConversationHost` is the product orchestrator. It owns task identity, approved acceptance criteria, backend turn coordinates, budget checkpoints and the `BoundedPlaytestTask` guard. The renderer receives a versioned `ConversationTaskRunReadModel`; it never computes cost, reads an artifact path, advances a task phase or decides that a task completed.

Backend turn completion and product task completion are deliberately separate. A backend can finish normally while the task remains `blocked` because approved acceptance criteria or persisted evidence are missing. Product completion requires a passing `EvaluationResultV2` whose cited evidence is retained in the same task projection with current provenance.

## Product workflow

Before execution, the user sees backend protocol/capabilities, model, reasoning effort, output limit, Prompt Profile and finite task budgets. `studio.plan.propose` may include fixed-DSL acceptance criteria. Plan approval freezes those criteria into a `TaskSpecV2`; it does not approve trusted code or runtime start.

The task surface follows `planning → editing → validating → playing → evaluating → repairing`. It shows current status, repair iteration, timeline, task/turn/tool/Play/tick coordinates, rate limits, usage, provider cache evidence and cost status. Unknown provider usage, cache hits or subscription billing remain visibly unknown.

Failed evaluation starts only an evidence-led bounded repair. The task account charges a repair iteration, while `BoundedPlaytestTask` rejects missing failure evidence, repeated fingerprints and exhausted repair limits. A hard budget checkpoint pauses the backend owner and asks the user whether to continue one bounded tranche or stop while preserving completed output.

## Evidence projection

The main process admits only the seven G10 observation types. Evidence is associated with task, turn, Play id, document revision, tick, frame, viewport and device. Cross-task and stale-revision evidence is marked invalid or stale; a pass claim without a retained current evidence id is downgraded and cannot complete the task.

Screenshot bytes remain in Operation Log CAS. Main may read only an already-cited screenshot artifact, validate the observation envelope and PNG base64, and expose a bounded `data:image/png` preview. No filesystem path crosses IPC. The UI clears prior image sources before replacing a task render so long-running screenshot review does not retain detached image payloads.

## Restart and retention

Task summaries are persisted as redacted content-addressed artifacts without screenshot preview bytes. Restart selects the highest revision for each of at most fifty tasks. A formerly running or waiting task becomes explicit `blocked / task.interrupted-by-restart` with a safe resume action when session and turn coordinates exist. Completed artifacts, acceptance results and timeline remain replayable.

The timeline retains the latest 400 authoritative entries; the renderer materializes only the latest 100 and reports the omitted count. Unknown task schema versions and malformed or secret-shaped fields fail closed during projection normalization.

## Accessibility and language

The task workspace and phase rail have explicit accessible labels and `aria-current`. Keyboard/IME composer behavior remains independent of task-card rendering. Critical paths expose concise Chinese product labels together with provider-neutral English identifiers, protocol versions, status values and diagnostics.
