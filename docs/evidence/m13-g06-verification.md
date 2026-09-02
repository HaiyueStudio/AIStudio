# M13 G06 verification

Implementation binding: `m13-g06-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

Formal Goal gate: `npm run m13:g06:check`.

Final current-tree run: Agent Runtime 57/57, Game Authoring Tools 50/50, desktop batch plus legacy Host regression 10/10. The local serial control measured approximately 272 ms versus 93 ms for the batch in the final run; the gate asserts a ratio rather than freezing volatile timing as a release baseline.

| Requirement | Authoritative evidence |
| --- | --- |
| frozen contract reuse | Contract check validates `ToolBatchRequestV1`/node schema and G01 binding; G06 creates no parallel envelope |
| legacy normalization | `normalizeToolBatchRequest` converts one or consecutive legacy calls into ordered nodes and derives revision/projection/failure policy under frozen limits |
| registry authority | classifier ignores model effect/risk metadata and uses registered effect, approval, explicit `concurrencySafe` and bounded argument identities |
| fail closed | missing or exceptional classification is `unknown-exclusive`; Play/Preview state calls are runtime barriers |
| DAG safety | package fixtures cover missing/implicit dependencies, explicit plus barrier cycle detection and deterministic ordered nodes |
| actual parallelism | three delayed reads reach observed concurrency 3 and complete near the slowest delay rather than the sum |
| exclusive barrier | fixtures prove two reads finish before a mutation/unknown barrier and a later read starts only after it |
| deterministic commit | deliberately out-of-order bodies produce request-ordered outcomes, commit hooks, Backend submits and `tool.completed` ops; repeat digest is identical |
| partial failure | a failed node cancels transitive dependents while independent work completes; `stop-batch` aborts active peers and pending nodes |
| cancellation and timeout | external abort and per-node timeout settle as bounded cancelled outcomes with explicit diagnostics |
| output bound/projection | batch result bytes are enforced; digest-only projection returns digest and byte length rather than full content |
| product rolling stream | desktop fixture emits four tool requests before results, observes two overlapping read bodies, an unknown-exclusive barrier and ordered provider submissions |
| serial control comparison | local protocol measurement runs the same three 90 ms observations serially and as one real Scheduler batch, asserts wall/tool wait below 70% of serial, and records model-call control 3→1 plus ordered results |
| Session/accounting | product fixture records planned/started/completed batch ops plus ordered node ops with latency, output bytes, UsageRecord and CostRecord refs |
| single-tool compatibility | existing G10 Host suite passes plan approval, tool approval, cancellation, project-missing recovery and budget continuation with Harness-style yield/wait calls |
| PTC protocol | versioned generic prompt module states `Plan → Tool batch → Check` and the same 64/4/60s/1MiB/3-round product bounds |

The model-call comparison is a local protocol control: serial mode represents three assistant steps each requesting one observation, while batch mode represents one assistant step requesting all three. It is paired with the real Conversation Host integration test, so the gate does not merely prove raw Promise concurrency. It is not presented as live provider performance.

The cost reference is explicitly `turn-shared`, because providers bill model usage at turn scope. G06 does not manufacture per-node Token prices; it retains exact per-node tool bytes and links every node to the auditable turn cost record. G11 will compare real Backend model-call count, wait time, wall time, usage, cost and cache across the 14 cold-start cases.
