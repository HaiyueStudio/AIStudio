# Task blocker and topology repair

## Observed task

- Session: `01a0909b-cdd7-7d10-9719-a2612e772308`.
- Task: `scope:6bf4d781-7867-48b3-92c0-f37a5c967275:task:conversation:3`.
- 2026-09-11 13:17 UTC: `camera.set` and `entity.create` failed with `query-scan-budget-exceeded` (31,727–31,964 retained events; per-query scan budget 10,000).
- Authoring had reached revision 4: 27 rounded cubies and 54 outer colored panels. No runtime evidence had been collected; all eight acceptance criteria remained pending. The generic final diagnostic concealed the earlier tool error.
- Tools ran for roughly 0.7–1.6 seconds each; model generation between tools took longer. The turn remained titled “User request”.

## Changes

- Receipt lookup, idempotency checks and member recovery walk bounded sequence windows across the retained journal. Empty windows and paginated results do not terminate the search. Small configured scan budgets shrink the window; receipt integrity and duplicate checks remain enforced.
- Failed tools are tracked until the same tool succeeds. An unfinished task preserves the unresolved tool code and message (an existing evaluator diagnostic still takes precedence). A failed initial edit does not trigger the “approved but never started” automatic retry.
- The graph highlights the active frontier: concurrent tools, user barriers or model continuation. Ancestors no longer all animate. The current-activity strip names the operation and can locate it. Nodes show status; completed tool failures retain their diagnostic.
- Between tools the turn is labeled “模型生成下一步” and reports the previous tool/result. This does not claim a tool is running while the model is generating it.

## Verification

Verification logs and final results are recorded alongside this file. Real Electron checks exercise moving tool border beams, concurrent tools, approval precedence, resumed tools, terminal cleanup and narrow-window layout. No live model generation or user project mutation was performed, and the running app was not restarted.


Final results: capability capture 12 suites / 124 passed; full integration 48/48 files, 227 passed / 2 failed / no skips. Full-check types, boundaries, evaluations (59), behavior (33), workspace (5), agent tools (110) and logic (23) passed.

The full run is **not green**: the product fixture requires a different fixed Windows machine, and the hover-detail close assertion fails at `graph-ui-main.mjs:43`. A fresh isolated retry fails at the same assertion; bundling the original Git HEAD chat panel and CSS also reproduces it. That existing hover issue was not changed in this repair. Separate focused runs exposed an unchanged Windows-path assertion on macOS and the 220ms batch timing threshold (concurrency/order assertions passed). Exact logs are retained here, without weakening assertions.

All newly added regressions passed. The real Electron running-tool beam test passed both alone and in the full run. The narrow viewport screenshot was visually inspected. AIStudio must be restarted to load this build; a fresh live generation has not been run.
