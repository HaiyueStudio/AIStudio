# M13 G08 Engine → Studio semantic capability census

Status: verified implementation, 2026-09-01. Binding: `m13-g08-2026-09-01`.

## Decision

G08 exposes a small registry-driven semantic surface instead of one property setter per Engine field. `tool.search` discovers tools and component descriptors on demand; `component.configure` merges a bounded patch into the authoritative Registry defaults or current value; every mutation still uses exact revision checks, effect classification, approval, Document History and evidence. Seven-game consumers are fixtures, not production prompt branches.

| Domain | Engine / runtime capability | Studio contract or component | Agent surface | Effect / evidence | Seven-game consumers | Status / owner / target |
| --- | --- | --- | --- | --- | --- | --- |
| Scene delta | Document revisions and History deltas | `SceneDiffV1` | `scene.query`, `scene.diff` | parallel read; revision/cursor digest | all | complete in G05 |
| Bounded observation | Scene projection | entity/component snapshots | `scene.get-many` | parallel read; ordered ids + missing ids | all | implemented in G08 |
| Atomic edits | Document batch and History | transaction receipt | multi-tool Scene transaction | exact revision; one revision/History entry/receipt | all | complete in G07 |
| Hierarchy | parent/order relationships | entity operations | `entity.hierarchy` clone/reparent/delete | approval; recoverable subtree History | match-3, jigsaw, platformer | implemented in G08 |
| Spatial layout | Transform component | `haiyue.transform.3d` | `transform.batch` set/align/distribute/snap/look-at | approval; one batch revision | all | implemented in G08 |
| Prefab and History | subtree serialization and shared Editor History | private bounded prefab registry; source-redacted History projection | `prefab.manage` capture/instantiate/remove; `history.query` | approval for prefab mutation; one revision; Undo/Redo; paged labels only | match-3, tetris, jigsaw, platformer, racing, shooter | implemented in G08 |
| Authoring camera | persisted camera settings | `studio.camera.main` | `camera.get`, `camera.set`, `camera.author` frame/orbit | History + Scene diff | snake, match-3, tetris, jigsaw | implemented in G08 |
| Gameplay camera | Engine Camera2D/3D and runtime follow | `haiyue.camera.2d/3d/follow` | `camera.author` create/activate/follow/projection/viewport | approval; component diff | platformer, racing, shooter | implemented in G08 |
| Tool discovery | Component Registry | capability manifest | `tool.search`, `component.describe` | parallel read; bounded summaries | all | implemented in G08 |
| Partial component authoring | registered runtime adapters | any registered component | `component.configure` | risk derived from descriptor; History | all | implemented in G08 |
| Script context | validator and project script catalog | script digest/revision | `script.symbols`, `script.patch` | digest-CAS proposal; source not repeated | all | implemented in G08 |
| Asset graph | controlled asset ids in component values | asset catalog + component ownership | `asset.search`, `asset.dependencies` | parallel read; exact JSON pointer | all | implemented in G08 |
| Keyboard/mouse/gamepad | Engine InputMap; preview input runtime | `haiyue.input.action-map` | `tool.search` + `component.configure` + `play.input` | descriptor validation + fixed-tick action trace | snake, tetris, platformer, racing, shooter | implemented in G08 |
| Pointer/touch | preview pointer routing and hit test | `haiyue.interaction.pointer` | `component.configure`, `play.input` | normalized pointer phases + rule/action trace | match-3, jigsaw, shooter | implemented in G08; higher-level gesture recognizers remain optional M14 UX presets |
| Physics body/collider/joint | Engine Box2D/Rapier systems | `haiyue.physics.*` | `component.configure`, `play.physics-query` | approval + bounded collision/physics observation | platformer, racing, shooter | implemented in G08 |
| Character control | runtime character and ground probe | `haiyue.gameplay.character/ground-probe` | `component.configure`, `play.physics-query` | approval + grounded/body trace | platformer | implemented in G08 |
| Ray/shape query | Engine/runtime raycast and overlap | bounded active-Play query contract | `play.physics-query` status/events/body/raycast/overlap | tick/frame-provenance observation | platformer, racing, shooter | implemented in G08 |
| Lighting/environment | Engine lighting and environment adapters | `haiyue.light.*`, fog | `component.configure` | approval + screenshot | all 3D games | available through the shared registry and covered in G08 effects fixtures |
| Postprocess/particles | Engine postprocess and particle systems | postprocess stack, particles 2D/3D | `component.configure` | approval + screenshot/lifecycle | match-3, racing, shooter | available through the shared registry and covered in G08 effects fixtures |
| Audio | runtime source/listener/mixer | `haiyue.audio.source/listener/mixer` | `component.configure`, asset tools | exactly one listener, gain/spatial lifecycle manifest | racing, shooter | implemented in G08 |
| HUD | isolated Play overlay | `haiyue.ui.hud` text/image/button/layout | `component.configure`, `play.input`, `play.inspect/capture` | declarative HUD observation, button action and screenshot | all | implemented in G08 |
| Gameplay primitives | fixed-step update, input and physics events | `haiyue.gameplay.state/timers/pool/rules` | `component.configure`, `play.input`, `play.inspect` | authoritative state, fired rule ids, timer events and actual pool instances | all | implemented in G08 |
| Runtime assertions | screenshot, state, trace, evaluator | observation artifacts | `play.inspect`, `play.capture`, `task.evaluate`; declarative and script observations | content-addressed state/screenshot/evaluator evidence | all | implemented in G08; formal gate below freezes composed coverage |
| Advanced authoring | navigation, terrain, saves, material/particle/postprocess graphs, audio mixer UI | not frozen for Studio | none | none | later 3D/large projects | P3 handoff to M14 |

## G08 exit gates

1. The seven-game machine fixture is aligned with every required generic tool/component and rejects genre-named production APIs.
2. Camera/input/physics/HUD/effects composition plus negative policy, stale revision, rollback, redaction and output-bound coverage runs from one formal verifier.
3. The verifier output is frozen in `docs/evidence/m13-g08-verification.md`; later capability changes must update the binding and replay the gate.
