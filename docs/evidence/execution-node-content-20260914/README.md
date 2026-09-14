# Execution node content verification — 2026-09-14

- Public assistant output is stored once per model/tool boundary and assigned using exact operation coordinates. No hidden reasoning is captured or invented.
- Tool intent/results correlate by session + turn + tool-call identity. Plans use barrier identities; changes and verification use recorded causal links. Aggregated task content is limited to its own membership.
- Details show public explanation, actual actions and results, hide unavailable technical fields, and keep long popovers clear of their trigger.
- Older graph projections without the new optional fields remain valid; malformed or oversized fields are rejected.

## Validation

- Focused graph, durable transcript/replay, integration: **41/41 passed** (`focused-final.log`).
- Additional forged content/legacy normalization check passed (`validation.log`).
- Real Electron graph, public explanation, tool intent/result, keyboard, live state, mouse panning, narrow viewport: **passed** (`electron.log`). Screenshot inspected.
- Project history tests: **4/4 passed** using `TMPDIR=/private/tmp` to avoid macOS `/var` symlink rejection; transactional batch test passed (`host-regressions.log`).
- Tool concurrency and provider-order assertions passed, but its existing total-time assertion failed at **234 ms vs <220 ms** on an isolated rerun (`batch.log`). This threshold was not changed. Diagnostic timing showed overhead before first tool and between tool completions; this is not a functional pass for the timing budget.
- Shell, orchestration and application builds passed.
- Repository check passed contract/type/boundary/upstream/candidate checks and quick evals, then stopped at **M14 stale verification input binding** (`root-check.log`). No milestone evidence was recaptured to bypass the gate.

The running user application was not restarted. Changes are available in the new local build.
