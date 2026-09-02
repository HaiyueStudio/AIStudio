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
