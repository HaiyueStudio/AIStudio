# M13 G08 verification

Implementation binding: `m13-g08-2026-09-01`  
Formal Goal gate: `npm run m13:g08:check`

G08 provides genre-neutral semantic authoring operations over the existing Component Registry, GameDocument, History, approval, Play observation and evaluator authorities. The seven game classes are consumers of the same contracts; there are no snake, match-3, tetris, jigsaw, platformer, racing or shooter production tool ids or prompt branches.

## Current-tree evidence

| Requirement | Executable evidence |
| --- | --- |
| bounded incremental context | `scene.query/diff/get-many`, `script.symbols/patch`, `asset.dependencies`, exact `tool.search`, diagnostics sequence filters and paged `history.query` tests |
| atomic semantic edits | camera, hierarchy, prefab, transform and registry component operations all use exact base revision plus one shared History transaction; stale, fuzz, rollback and approval fixtures fail closed |
| reusable hierarchy | `prefab.manage` captures up to 128 entities, validates components and script digests, instantiates fresh ids, removes recoverably, and proves complete Undo/Redo |
| source redaction | prefab script source remains private project data; tool results, History projection and `scene.query(settings)` do not expose it |
| camera | create/activate/frame/orbit/follow/projection/viewport and top-down orthographic authoring tests use the same camera component/settings authority |
| input and interaction | action maps, normalized keyboard/pointer/gamepad events, fixed-tick `play.input`, pointer interaction and declarative input rules share one runtime path |
| declarative Gameplay | state, timers, pools and generic trigger/action rules project authoritative state, fired rule ids, events and actual instance counts without genre-specific code |
| physics | real Box2D/Rapier fixtures cover platformer grounding/jump, racer collision, shooter CCD trigger, joints, lifecycle, body status, events, raycast and overlap |
| HUD and audio | declarative text/image/button/layout projection and exactly-one listener semantics are covered by pure runtime and render-effect lifecycle tests |
| visual effects | lighting/material ownership, postprocess ordering/device loss, 2D/3D particles, 2D/3D animation and controlled assets have bounded manifests and teardown tests |
| isolated Play closure | a real sandboxed Electron iframe starts revision 17, injects `HardDrop`, observes score 2→12 and `hard-drop`, renders updated HUD/button, observes listener gain, captures a same-tick PNG and tears down to zero |
| non-hanging start failure | the same Electron fixture submits mismatched fixed-step settings and receives an explicit lifecycle failure in under five seconds rather than leaving Approve/Run pending |
| seven-game coverage | the machine fixture requires authoring → input → state → screenshot → evaluator for snake, match-3, tetris, jigsaw, platformer, racing and shooter, with shared Gameplay state/rules/HUD components in every case |

## Capability boundary

The machine-readable census contains no `gap` or `partial` row owned by M13 G08. Navigation, terrain, save systems, full material/effect graphs and audio mixer UI remain one explicit P3 `handoff` to M14; G08 does not claim those advanced editors are implemented.

## Gate composition

The formal gate runs contract and repository boundary checks, complete Editor Plugins, Game Authoring Tools and Script Preview suites, rebuilds the desktop app, executes declarative Gameplay, observation, real physics and render-effect tests, executes the real Electron iframe/screenshot fixture serially, then validates the census, seven-game coverage, generic API policy and evidence binding.
