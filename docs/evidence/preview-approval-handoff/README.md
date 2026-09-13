# Agent preview returns at approval handoff

The prior ownership policy explicitly retained an Agent preview while its owning task was `waiting-user`. Consequently, a test ending at a plan, tool approval, question or budget handoff kept the Play page in front of the authoring/approval interface.

The preview now belongs only to active task execution. A transition to user input closes that Agent-owned preview through the existing renderer cleanup and exact-instance broker report. It preserves the task and pending approval; a later authorized Play start must claim a new preview. Manual previews remain open. The poll cleanup finally block also covers conversation/scene refresh errors so a known handoff cannot strand the user on Play.

16 focused tests passed: ownership across turns, handoff in planning/playing/evaluating/repairing, subsequent fresh claim, manual-preview isolation, matching-instance broker cleanup, polling coalescing/failure recovery, and native Electron production poll/stop/page behavior. The native fixture replaces GPU initialization and IPC transport, but executes production lifecycle and page code; it verifies exactly one dispose/report, authoring page restoration, no conversation cancellation, repeated pushes and refresh failure. It does not run the user's game.

The three existing test files are also registered in the capability capture as `agent-preview-handoff`.

User project content and the running application were not modified/restarted.

## Manual exit

The old button awaited a successful provider cancellation before calling local preview cleanup. A released/stale turn rejected cancellation, or a delayed backend kept it pending, so the page never exited. The button now starts cancellation while independently hiding and disposing the local preview. Cancellation failure is reported explicitly in the authoring UI. Human barriers have no live turn to cancel and remain actionable. Missing turn coordinates no longer disable local exit.

The native test clicks the production button for a stale turn, delayed acknowledgement, pending human approval, a manual preview and missing coordinates. Every case verifies the actual page display and exactly one cleanup/report; the delayed case verifies exit before resolving cancellation. Agent cancellation requests are only made for applicable Agent-owned turns. A failed cancellation does not claim the task stopped.

Root check passed contracts, typechecks, boundary/upstream/candidate checks and 59 evaluation tests, then stopped at the expected stale source-bound capability digest. The final capture regenerates that record; later full root integration phases are not claimed as run.

Final capability capture: 159 passed, 0 failed/skipped/cancelled, including the 16 preview/poll tests. Current app build contains both automatic handoff and manual exit fixes.
