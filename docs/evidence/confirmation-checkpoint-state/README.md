# Confirmation checkpoint state

A durable user barrier releases the provider call with a cancelled terminal event. The graph previously displayed that physical call status as a cancelled product step.

The host now records suspendedBarrierId on released turns. The graph projects correlated checkpoints as waiting, including the paused turn, checkpoint result and barrier-related tool/batch. Pending details use 待确认 and 等待原因, and summaries no longer start with cancelled. Explicit cancellation, refusal and failures remain terminal.

Historical events are supported only when the exact host checkpoint reason and a same-turn request are present. Matching uses the stored barrier identity for new records; unrelated requests cannot mask a cancellation. Raw journal facts and approval/execution policy are unchanged.

A resolution retires the paused phase. Only a real turn.started starts processing: the same turn node may reopen, or a fresh continuation node becomes active. Final completion clears its beam. The pending frontier belongs to the human barrier, not its summary ancestors.

Validation includes 21 graph tests and real Electron checks of pending details, cancellation styling, approval continuation and terminal beam cleanup. The first integration pass had one short polling timeout; the isolated mutation-approval retry passed. The polling helper now uses a bounded 10-second elapsed timeout instead of approximately 1.5 seconds, preserving scoped grant and single-execution assertions. Final formal results are recorded separately.

The user application was not restarted.

Final verification: 275 tests passed across 18 formal capability groups with no failures or skips, including all 17 approval/budget recovery cases and all 24 topology state/window cases. The generated census is bound to the final source.

Required root check passed type/boundary/candidate checks, quick evaluations, capability binding, builds, docs and 33 behavior tests. Workspace checks had 4 passes and one pre-existing failure at split-layout.test.mjs:69 (expected UI 0.1.3, current app 0.1.4); those files are unchanged by this fix. Later root agent-tools/logic/integration stages were not reached. The formal capability groups above independently cover this change. No full-root pass is claimed.
