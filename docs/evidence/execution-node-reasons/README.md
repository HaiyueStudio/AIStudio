# Execution graph terminal reasons and colors

- Failed and outcome-unknown nodes use a muted red background; cancelled nodes use a light grey background with dark text. Selection/focus retain the state color.
- Terminal tool operations persist a bounded, redacted reason separately from the diagnostic code and model-facing output projection. Durable human barriers explain that the provider call was released at a saved checkpoint. Turn records retain known cancellation/backend reasons.
- Graph projection reads explicit reasons, structured diagnostics and legacy tool failure summaries; batches and turns summarize matching structural child causes. It never attributes unrelated failures to another batch. Old records without a cause explicitly show that the cause was not recorded.
- Details render the reason as text. Successful retries clear stale reasons. The hover panel now closes after the pointer leaves a streamed replacement even if that replacement received no pointerleave event.

## Verification

- 14 graph projection tests passed, including deterministic replay, cause aggregation, missing historic data and successful retry.
- 6 approval/checkpoint tests passed, including a real Electron restart and durable plan cancellation reason persistence.
- Native graph UI regression passed after the hover lifecycle fix: failure/cancellation colors on selection, explicit causes, historical fallback, streaming hover restore/close, keyboard, zoom, narrow layout and cleanup. Screenshots were visually inspected.
- One existing tool-batch timing assertion did not pass (220 ms threshold; observed 227–431 ms on sequential retries; the final isolated run was 227 ms). Its overlap, commit order and exclusive barrier assertions passed; the separate all-mutation transaction test passed. The timing threshold was not changed.
- Root check passed contracts, typechecks, boundaries, upstream/candidate checks and 59 evaluation checks, then required recapturing the source-bound capability report. The log records that intermediate stale-digest failure; it is not a claim of full root-suite success.

The running user application was not restarted and no user project was modified.

- Final capability capture: 143 passed, 0 failed/skipped/cancelled; source-bound consistency check passed. App build includes the final hover lifecycle change. Full root integration phases after the capability gate were not rerun.
