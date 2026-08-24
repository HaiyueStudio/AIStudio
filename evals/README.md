# Cross-genre game Agent evaluation suite

This directory is the executable installation of `m12.game-agent-evaluation` v1.0.0. It evaluates game-authoring Agents against the same seven case IDs and hidden behavior oracles in deterministic fixtures and real backend runs.

## Coverage

The suite covers Snake, match-3, falling blocks, jigsaw, platformer, racing, and shooter requests. Every case has a canonical request, at least two phrasing variants, required G01 capability IDs, deterministic replay steps, functional/visual/robustness acceptance IDs, and at least two seeded defects. The three supported modes are `cold-create`, `warm-repair`, and `seeded-defect`.

## Isolation and evidence

Only `{ schemaVersion, request, constraints }` is passed to the Agent. Replay scripts, acceptance text, failure seeds, and oracle conditions remain runner-only. Visual rules require screenshot evidence corroborated by state or event signals; a screenshot digest alone cannot pass.

`reference-evidence-v1.json` is synthetic, CC0 behavior metadata used to test the evaluator itself. It contains no provider output, generated game code, or image bytes. A real adapter must capture PNG evidence with a content digest, viewport, semantic analyzer version, and behavior signals, then return the same seven evidence types accepted by `EvidenceCollector`.

## Adapter contract

`EvaluationRunner` creates a fresh blank GameDocumentV2 for every task and invokes four adapter methods in order:

1. `resetProject(blankSpecification)`
2. `executeAgent({ agentInput, runContext, budgets })`
3. `executeReplay({ replay, failureSeedId, runContext })`
4. `collectEvidence({ runContext })`

The case ID and hidden replay are transport metadata and never become model-visible input. Adapters may also implement `dispose()`. `executeAgent` must report integer `turns` and `toolCalls`; the runner enforces suite budgets before scoring.

Run `npm run m12:g02:check` to validate schemas, isolation, fixture truth tables, deterministic reports, manifest digests, and the complete G02 test suite.
