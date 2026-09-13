# Budget checkpoint recovery and terminal topology

## Reported failure

The project-scoped diagnostic reported `agent.resume-missing` while trying to resume a local `turn:approved-plan` checkpoint. The preceding budget question reported 201,498 input tokens against a 200,000-token limit. No provider turn had been started for that local coordinate.

In the reported path, a durable tool approval released the prior provider call. After approval, `continueTask` checked the budget before establishing its active task owner. The budget question consequently had no task owner, while the TaskRun retained the preceding provider coordinates. Answer recovery failed to find the task and fell back to provider resume with the local checkpoint id. The Codex adapter correctly rejected this unavailable turn.

The host projected a diagnostic but did not append a terminal Session operation when start/resume failed before the first stream event. The graph therefore continued to project the recovered user message as active model work.

## Changes

- Establish continuation ownership and persist its local task coordinates before budget checks and context preparation. Preparation and budget suspension share the same cleanup owner.
- Persist task membership on budget questions. Recover older budget checkpoints only from recorded task membership or the task's matching budget timeline; an unbound budget question cannot fall back to provider resume.
- Resume approved work by starting a fresh provider turn with the original task and acceptance criteria. A single approval grants one bounded budget tranche. Stop preserves committed project work. Inline approval pauses the wall-time clock; continuation rearms it against the renewed budget. Wall-time expiry uses the current authorized limit.
- Close the local checkpoint after its answer so it does not remain a second active graph.
- Persist failure/cancellation terminal facts, diagnostic codes and bounded redacted reasons when the stream fails, including before the first event. Finish pending progress and streaming text without relabeling failures as successful progress.
- Repair historical missing terminal facts on graph restoration from explicit host-failure records. Append facts without rewriting history; preserve a newer attempt and avoid duplicate terminal records on reload.

## Verification

`regression.log`: 64 tests passed across durable barrier recovery, task product continuation, bounded continuation context budget/accounting, inline Agent integration and graph projection. Coverage includes scoped input-token overrun matching the report, between-turn turn-budget exhaustion, approval after restart, legacy checkpoint membership, stop, first-event start/resume rejection, streaming rejection, replay, historical graph repair, and preservation of a newer attempt. Existing Electron process restart approval tests also pass.

`root-check-before-capture.log`: repository checks reached the capability evidence binding gate. Contract, type, boundary, upstream/candidate/protocol and quick evaluation checks passed; the previous evidence digest was stale after the source change. The capability capture and subsequent check below replace that stale evidence.

`orchestration-build.log`: orchestration package build passed. The capability capture also rebuilds the application.

These regression cases use deterministic provider fixtures, plus the existing real Electron process restart test. No live Codex generation was started for validation. The running AIStudio and the user's game project were not restarted or modified.

Final capability capture: **176 tests passed**, including **17 budget checkpoint recovery cases**. `capability-check.log` confirms the report matches the final source digest in `capability-verification.json`. The final app build exited successfully. `verification.json` records the verification scope and remaining live-app boundary. Later stages of the repository root check were not rerun after the capability gate was refreshed.
