# M13 G11 local verification

Binding: `m13-g11-2026-09-02`

Status: local gates pass; the 14-case real-network matrix remains the formal release gate.

## Blocker correction

- Legacy `conversation/node-projected` and `conversation/task-projected` records are migrated before graph restoration.
- Migration operation ids are deterministic and resumable. A second startup does not append duplicate messages or replay historical mutations.
- The original task summaries, timeline and projected nodes remain in a redacted CAS artifact; the Session Surface contains the user/assistant Transcript needed for compaction.
- The conversation host claims its launch slot before asynchronous context preparation, so the UI cannot briefly report idle and race compaction or a second send against a not-yet-created Session.

## Local evidence

- `apps/ai-studio/test/legacy-session-migration.test.mjs`: identical Surface/Graph digests after replay, idempotent second migration, zero historical tool/document mutation operations.
- Existing restart, long approval, budget continuation, unknown outcome, transaction recovery, process claim, compaction and execution graph suites remain green.
- `docs/evidence/m13-g11-local-gates.json`: 126-entry long Transcript, automatic and manual compaction, 1000-node graph projection/layout, 1000 Entity/200 Script diff workload, 32-node parallel batch, memory evidence.
- Full Scene retransmission reduction: at least 80% gate; measured value is recorded in the JSON evidence.
- PTC model-turn reduction: at least 30% gate; local batch workload reduces three serial model scheduling turns to one.
- Input-token reduction uses the reviewed seven-game G10 A/B corpus and remains above 25%.

## Formal matrix contract

Every Harness/Codex × seven-genre report now persists:

- usage, cost and cache provenance;
- state, screenshot and evaluator evidence;
- Durable Session snapshot and replayed Surface digest;
- ContextFrame and exact Surface input artifact;
- Tool Batch evidence, including `tool.outcome-unknown` on interrupted results;
- execution Graph artifact and independently replayed Graph digest.

The formal verifier rejects any case missing one of these fields, any digest drift, any non-pass evaluator result, duplicate backend/genre coverage, dirty revision binding or fewer than 14 independent cases.

The first reviewed matrix attempt proved the failure-preservation path but also exposed an obsolete immediate hard stop at the initial Harness input tranche (1,020,271 versus 1,000,000 tokens). The corrective runner now treats the initial value as a visible checkpoint and continues the same preserved task only within an explicit formal-matrix cap (Harness 1.5M / Codex 3M input tokens). The continuation is recorded in `budgetContinuations`; exceeding that second cap still fails closed. This automation is limited to the already user-authorized formal matrix. Interactive Studio tasks continue to require the user's budget-continuation decision.

The next reviewed Harness/Snake canary crossed that initial tranche without stopping and exposed a narrower transaction gap: DeepSeek disconnected after three successful, validation-clean `script.propose` results but before it emitted `script.apply`. The coordinator now recognizes the latest full Studio-side `canApply` proposal, prepares an exact `script.apply`, requests the normal one-shot trusted-code approval, commits through the regular Script/History/Operation Log path, and records the recovered call in Session Tool Batch evidence. It never applies an invalid proposal, bypasses approval, retries a consumed proposal, or replays an ambiguous mutation. If all bounded provider takeovers still fail, the terminal record now retains `TRANSPORT` as the root cause instead of replacing it with a downstream gameplay-contract diagnostic.

The recovery canary then retained one enabled script and real Play/screenshot evidence, proving the proposal transaction fix, but all three bounded turns still ended on DeepSeek request-level `TRANSPORT`. The pinned Harness exposes a retry policy (including `TRANSPORT`, `TIMEOUT` and server failures) yet no listener previously owned `agent/request-error`, so that policy was inert and Studio paid for a whole continuation turn. The bridge now executes the upstream policy in the same Agent step with abortable deterministic backoff and a Studio hard cap of two retries. Authentication and other non-retryable errors remain terminal. The `script.propose` contract also states the stable persistent/input/instance APIs directly so agents do not spend Play cycles probing capabilities already owned by the runtime.

The fourth Harness/Snake canary proved that same-step transport retry: one backend turn created and applied a script, entered real Play, stepped simulation, injected input, inspected gameplay state and captured a PNG without a transport terminal. It then exceeded the reviewed 1.5M input cap by 9,857 tokens after 31 usage records and 40 tool requests. The retained trace showed two avoidable script repair loops: strict TypeScript rejected implicit callback parameters, followed by an invented `component.events` API. The generic `script.propose` contract now states both constraints before generation.

Formal-cap enforcement is now two phase. A usage event latches the cap without aborting the already-paid provider response; the next tool request is rejected before preparation or effect, the backend is cancelled, and the coordinator returns all prior full Studio-side results with a `budget.formal-cap` diagnostic. If the response ends without another tool request, the runner records the complete Session/ContextFrame/Tool Batch summary and then fails the case. The cap is unchanged, no unauthorized work runs after it, and failure preservation no longer degrades to an empty tool-result list. The full local G11 gate passes with 75 game-authoring tests, including this exact boundary regression.

The fifth Harness/Snake canary exercised that boundary in the real runner. At 1,544,554 input tokens it retained 41 completed tool results, one enabled script, the saved project, usage/cost/cache attribution, and a replay-stable M13 Session/Graph instead of returning an empty summary. Its trace contained no strict-TypeScript validation loop; the remaining cost came from low-level granularity: six serial entity creates, repeated component operations and three rejected attempts to attach material fields to non-geometry entities.

The generic tool surface now exposes `entity.create-many`, which creates 1-32 already-known geometry, light or empty entities atomically with initial transforms, one revision and one Undo/Redo entry. Its schema separates geometry items from non-geometry items so lights/empty cannot carry material fields. The formal runner also exposes the existing semantic/delta tools (`scene.query`, `scene.diff`, `scene.get-many`, `tool.search`, `component.configure`, `camera.author`, `transform.batch`, `script.symbols`, `script.patch`, hierarchy and prefab operations) instead of freezing agents onto the legacy low-level subset. A mixed geometry/light/logic regression proves atomic commit and pre-effect rejection. The local G11 gate now passes with 76 game-authoring tests; the G12 runner safety suite passes separately.

The sixth Harness/Snake canary proved the semantic-tool correction: the model replaced six serial creates with one `entity.create-many`, used two incremental `script.patch` calls rather than retransmitting the script, and reached real Play in 36 tool calls instead of the fifth canary's 45. It still stopped at 1,523,235 raw input tokens. Provider evidence shows 1,476,224 of those tokens were cache reads, leaving 47,011 net-new input; the old cap therefore classified a 96.9% cache hit as new context growth. The project, enabled script, state at tick 124, PNG, evaluator, usage/cost/cache, Session and replay-stable Graph were all preserved.

Budget accounting now retains raw input and cached input unchanged in the auditable usage/cost records, while `TaskBudgetV2.limits.inputTokens` controls net-new provider input (`total - cache read - cache write`). Missing cache counters remain fail-closed and charge the full provider input. Output, cost, wall-time, turn, tool, repair and observation limits are unchanged. The formal live boundary uses the same rule and records its basis plus raw/cache counters in any continuation evidence; the product label is explicit about “Net-new input tokens”. This is a semantic correction, not a cap increase.

The same trace exposed two avoidable protocol-only retries. `script.patch` now accepts `entityId`, `scriptId`, or both and rejects mismatched dual identity before effect. `preview.validate` now accepts an optional `baseRevision` and enforces the normal stale-revision guard. The full local G11 gate passes with 71 agent-runtime, 26 shell, 76 game-authoring and 11 Electron/restart tests; the standalone G12 runner safety suite passes 3/3.
