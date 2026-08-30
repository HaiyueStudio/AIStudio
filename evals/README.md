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

## G12 promotion boundary

`npm run m12:g12:quick` is the credential-free cross-genre regression included in the repository root check. It validates all seven hidden-oracle cases and the fail-closed G12 promotion policy, but it is not formal acceptance evidence.

Formal acceptance is read from `evals/evidence/g12/formal-acceptance.json` by `npm run m12:g12:verify`. The verifier recomputes every referenced artifact digest, requires AIStudio/Engine/milestones to match the same clean reviewed revisions, and then enforces the Electron/WebGPU, independent Harness/Codex, seeded-repair, lifecycle, cache, budget, secret, packaging and soak gates. Synthetic fixtures and artifacts under a `fixtures` directory are rejected from formal promotion.

The real replay path is split into three reviewed layers: `compileG12ReplayProgram` rebases suite time to the actual paused iframe tick, the semantic-driver registry provides bounded black-box input strategies for every scripted action, and `executeG12ReplayProgram` schedules fixed input plus structured gameplay triggers. Generated scripts publish bounded owner-scoped JSON with `api.scene.observe`; replay completion requires this authoritative state, rejects runtime errors and stale ticks, and captures screenshots only at the matching final state tick. HUD text alone is never accepted as a trigger.

`npm run m12:g12:real-cold -- --evidence-class=formal` runs the Harness/Codex × seven-genre matrix serially. Every case creates a fresh project and backend session, uses only allow-once tool authorization, executes the hidden replay in a real Electron/WebGPU iframe, and atomically writes project, usage, cost, cache, state, screenshot and evaluator artifacts. A matrix checkpoint is updated after every case, so `--resume=true` preserves completed provider work. Formal mode checks all three repository worktrees before launching Electron or making a provider request; `--evidence-class=preflight` is the only mode that permits dirty revisions and its reports remain non-promotable.
