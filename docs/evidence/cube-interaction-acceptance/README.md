# Cube interaction and acceptance repair

The latest recorded task exhausted five repair iterations at document revision 9. Its controller was not revised after the first applied script. The recorded gesture calls include 33 result-size failures and one batch wall-time failure. Gesture execution could succeed before the full baseline/final observations overflowed the 65,536-byte tool result ceiling.

Two editor defects are fixed:

- Evidence paths now traverse canonical array indices such as `gameplay.0.value.metrics.moveCount`, retaining own-property checks and rejecting non-index array properties.
- Model-facing observation projections are independently bounded to 8,192 bytes. Full immutable artifacts, provenance validation, persistence quotas and evaluator inputs remain intact. Gesture results include each step's configured interaction target/world hit and authoritative entity/camera changes.

The recorded controller already used Engine-backed `api.input.interactions()`. It did not implement its own raycaster. Reconstructed latest entity snapshots contain 27 cubies and 54 stickers, all without parents; only one corner cubie has an enabled pointer interaction component. The script accepts only two hardcoded entity IDs, rotates a fixed left layer, and treats unrecognized drags as camera input. Its camera branch changes Cartesian orientation rather than orbiting position around the cube. Declared cubie/sticker counts are hardcoded observations, not independent verification.

`preview.validate` now reports bounded pointer-target inventory. Searchable input/evidence guides explain interaction coverage, resolving selectable children to logical owners, choosing layer axes from hit normals and drag direction, and verifying authoritative changes. The generic drag example resolves a hit child's parent chain. Native preview regression verifies a selectable child rotates its owner while leaving the camera unchanged, including release outside the mesh.

`recorded-evidence-replay.json` is a sanitized read-only replay of the actual final evidence set. Three false missing-field failures become passes. Move count is still zero (a failed condition), and screenshot/performance artifacts are still absent from that evaluated set. No task is forced to pass, no repair budget was raised, and no live project or historical record was rewritten. The existing generated game still requires controller and hierarchy corrections.

## Verification

- Focused runtime, observation and retrieval suites: 68 passed.
- Native pointer fixture: passed; 40 placement checks plus object/background, capture/cancel and composite-child drags.
- Formal current-source capability capture: 18 groups, 277 passed, no skips or failures.
- Root check passed contracts, type checks, boundaries, candidate checks, evaluation suites, census, builds, bundled documentation and 33 behavior tests. Workspace tests: 4 passed, 1 existing failure at `apps/ai-studio/test/split-layout.test.mjs:69` (expects UI 0.1.3, manifest already uses 0.1.4 in HEAD). Later root agent-tools/logic/integration stages were not reached. The unrelated assertion and dependency were not changed.
- Current application was not restarted; the generated project was not rewritten.
