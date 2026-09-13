# Execution goal and turn status

## Root causes

The grouped goal mapped a TaskRun's acceptance `blocked` status directly to graph `failed`, even while that task's current provider turn was still evaluating or collecting evidence. The reported task eventually ended with `task.repair-no-change-repeat`; that acceptance blocker must remain visible without prematurely presenting an active execution as failed.

Separately, a budget continuation answer was appended as a user message to a provider turn which had already ended as cancelled. Message projection overwrote that turn's terminal status with running. Its completed tools then caused the UI to label it “模型生成下一步”. Read-only replay of the reported project's journal confirmed this exact order: turn completed, later user message, question resolved.

## Changes

- Explicit turn lifecycle operations own turn execution status. Later transcript or barrier answers cannot reactivate a terminal turn. Only a subsequent `turn.started` reopens it, clearing the previous completion time and terminal reason.
- A blocked acceptance goal follows its current task/session/turn: running during ongoing execution, waiting at a human barrier, and failed after execution stops with unresolved acceptance. Older or unrelated active turns do not override the task's current state. Explicit host failure stays failed.
- The grouped goal's detail uses its own task diagnostic and terminal timeline reason rather than inheriting an unrelated session-root reason. Active execution retains its acceptance diagnostic without claiming terminal failure.

## Verification

49 focused tests passed: 19 graph projection cases, 2 context/snapshot-order cases, 1 real Electron graph/window test, 17 budget checkpoint recovery cases, and 10 task acceptance/continuation cases. The app build passed.

Read-only replay of the reported project showed: during evaluation, acceptance status blocked with goal status running and one running turn; after the terminal event, the goal reports its acceptance blocker and has zero running turns. The earlier unknown-outcome tool remains explicitly unknown; it is not rewritten as successful or discarded.

User project data and the running application were not modified or restarted. The regression provider cases are deterministic fixtures; no new live Codex generation was started.

The repository root check passed contract/type/boundary/upstream/candidate/protocol checks and 59 quick evaluation tests, then stopped at the previous capability report's stale source digest. The final capability capture refreshes that binding; later root-check stages are not claimed as rerun.

Final formal capture: **198 tests passed**, including the **22 execution-status cases**. The application build exited successfully, and `capability-check.log` verifies the final source binding. `verification.json` records the exact validation scope. AIStudio has not been restarted for this change.
