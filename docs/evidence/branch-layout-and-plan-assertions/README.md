# Branch alignment and compound plan acceptance

2026-09-14.

## Execution graph

The previous layout independently packed every column. A batch with many tools pushed later tools down without moving their parent batch, producing long overlapping links. Layout now allocates complete branch rows: a parent shares the row of its first visible child, and each following sibling starts after the preceding branch. Containment owns the branch; additional dependency edges keep their original meaning and layer constraints. Shared nodes are not duplicated. Status priority is applied among siblings, not independently across entire columns. Overview filtering and expansion still use the same graph truth.

`layout.png` is an isolated Electron capture using the production graph renderer and stylesheet. Its three batch nodes were checked against their first visible child's top coordinate. Tests cover mixed statuses, shared dependencies, filtering, collapse, deterministic replay, non-overlap, canvas bounds and the existing 1000-tool performance checks.

## Plan acceptance

The reported plan's first assertion contains four complete `evidence ...` expressions joined by semicolons. The former atomic parser tried to read the remainder as a single JSON value and rejected it. The 2000-character limit was generic guidance, not the cause.

Plan admission now splits explicit semicolon-separated conjunctions outside quoted JSON strings and containers, validates every member using the existing evaluator parser, and presents separate acceptance rows before user approval. Labels are numbered; required/category flags are retained. Atomic assertions remain unchanged. Invalid/empty members, unavailable evidence producers and total acceptance-count overflow still reject the proposal without dropping any requirement. Error messages identify the particular member and concise correction instructions instead of repeating the full tool manual.

The exact reported five groups normalize to fifteen independent checks. `reported-plan.json` retains only the relevant diagnostic evidence and first group's assertions. This verifies plan admission, not that the generated game passes runtime acceptance. Current user projects and the running application were not modified or restarted.

Final verification: 24 layout/projection tests, 7 plan tests and 53 conversation/evaluation regressions passed (84 total), plus the isolated Electron window. Application build passed. Root checking passed contract/type/boundary/candidate/protocol/M12 quick stages, then stopped at the pre-existing stale M14 acceptance binding; no acceptance record was manually rewritten.
