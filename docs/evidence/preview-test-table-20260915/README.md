# Agent preview verification table — 2026-09-15

The Agent-only preview progress panel now uses a semantic table with Test case, Expected effect, and Status columns. Status badges use exactly 待验证 / 未通过 / 通过 / 进行中 (Pending / Failed / Passed / In progress in English).

Acceptance expectations describe their existing assertion; the renderer does not evaluate or invent criteria. Pending and blocked criteria remain pending, with the reason shown inline. Pass/fail follows the authoritative acceptance result. Actual preview commands appear as explicitly labelled verification operations with their own command-specific expected result and running/completed/failed outcome; a successful command does not mark unrelated acceptance criteria passed.

Rows update by identity; equivalent updates retain row DOM. The panel is positioned inside the preview stage so wrapping toolbars and the Agent notice remain unobstructed. Desktop and 390 px layouts were inspected; see table.png and table-narrow.png.

Validation:

- Production-function sandboxed Electron fixture passed: exact columns/status labels, expectations, diagnostics, row identity, narrow layout, Agent/manual ownership, automatic approval handoff, stop/exit behavior and authorization reuse (`electron.log`).
- Preview ownership/broker tests: 13 passed (`ownership.log`).
- Final application build passed (`app-build.log`).
- Repository check reached the pre-existing M14 capability census stale verification input binding failure (`root-check.log`); no baseline regenerated and no milestone advanced.
- No live AIStudio restart or user project changes.
