# M13 G05 verification

Implementation binding: `m13-g05-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

The formal Goal gate is `npm run m13:g05:check`.

| Requirement | Authoritative evidence |
| --- | --- |
| contract ownership | M13 contract index binds `SceneDiffV1` to G05; schema validation remains part of `contracts:check` |
| bounded Scene query | Editor fixture covers 0/1/1000 entities and 200 scripts with pages of at most 73; every script item lacks source text |
| retained exact revisions | `SceneContextRuntime` freezes one base and replays bounded Document deltas instead of reading the live Engine World |
| divergent delta safety | every incoming delta is replayed and compared with the authoritative target digest; a seeded divergent operation resets to the correct target baseline and makes the old revision explicitly pruned |
| complete Scene diff domains | Editor fixture asserts add/remove/reparent/reorder, component field patch, script, asset dependency, camera setting/component, render setting, tombstone, transaction and provenance |
| replay evidence | retained operations reconstruct the target revision, whose safe digest equals an independently initialized authoritative target snapshot |
| cursor and history failures | Fixtures inject changed query shape, a tampered cursor, future revision, pruned history and a missing intermediate revision; all return the expected recoverable diagnostic |
| immutable exact/durable/semantic order | Agent Runtime fixture asserts fixed ordered inputs, stores them in CAS and captures a frozen `ContextFrameV1` with the same cache prefix digest on reread |
| bounded recovery | recoverable pruned history creates an explicit `snapshot-recovery`; a nonrecoverable exact-source failure remains fail closed |
| diagnostics/evidence/play trace delta | Operation Log fixture proves separate high-water cursors, sparse-event safety, raw-payload redaction, artifact provenance and cursor-tamper rejection |
| retransmission reduction | one baseline followed by six revisions performs one query and six diffs; measured full Scene retransmission reduction is 100%, above the 80% gate |
| tool surface | tool catalog exposes low-risk observe-only `scene.query`/`scene.diff`, schema bounds limit to 1000 and runtime maps them to Project Workspace |
| identity-only project snapshot | tool fixture asserts `project.snapshot` contains identity/health fields and no settings, camera or Scene dump |
| legacy prompt integration | Agent Runtime fixture proves exact source sends bounded snapshot then revision diff while preserving the fallback for non-product callers |
| desktop composition | app integration fixture constructs the real workspace and prompt context, adds an entity, then observes only the revision diff without script text |
| package boundaries | formal verifier checks Document/History ownership, provider-neutral Router imports and absence of provider packages in the exact path |

Focused package evidence recorded during implementation:

- Editor Plugins: 30/30 passing, including 3 G05 Scene context scenarios.
- Agent Runtime: 57/57 passing, including 4 G05 Router scenarios and the exact Prompt Context integration.
- Game Authoring Tools: 40/40 passing, including the product tool surface scenario.
- Desktop app: the formal gate rebuilds the application and runs the cross-package Scene diff integration test.

The 100% retransmission figure counts full Scene transmissions after the required first baseline; recovery snapshots are deliberately counted as full transmissions. It does not claim lower provider Token usage by inference—G11 will measure actual Backend usage/cost/cache across the 14 cold-start tasks.
