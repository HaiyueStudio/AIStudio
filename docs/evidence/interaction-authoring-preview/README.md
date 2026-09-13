# Interaction authoring and preview verification

The reported generated controller used Document entity IDs with Engine `world.getEntity`, which resolves runtime IDs or names. Failed lookups were ignored while success counters still advanced. Its background branch rotated cubies instead of the camera; its layer branch rotated a fixed list around individual centers instead of moving an articulated layer around a common pivot. Inspection of historical tool parameters also found inputs scheduled at ticks 9000–100012; scheduling is not execution.

The renderer also substituted a moving-position demo script whenever the selected object had no bound script. This made unscripted objects look scripted. The panel now loads an empty editor with a localized explanation directing initial transforms to Properties; an Electron regression verifies both unbound and bound objects.

Changes:
- Authoring plans, tool descriptions and searchable guides prefer persisted initial Transform/component values. Script proposals provide an advisory for likely initialization-only code; no existing project is automatically rewritten.
- `api.read.find` resolves stable Document IDs in native and headless Play, while retaining numeric IDs and names containing spaces or non-ASCII characters. Validation warns about ambiguous `world.getEntity` calls.
- Pointer capture retains the down target through drag/up/cancel outside its mesh. Per-event drag state handles down/move/up in one tick; blur/reset emits cancellation. Captured events retain the last valid surface hit; raw pointer events carry current normalized coordinates.
- `play.pointer-gesture` executes bounded down/move/up or cancel sequences through the same simulation/picking path as native input. It advances each event and returns persisted baseline/final observations. Actual entity and camera transforms remain the acceptance authority; command success is not task acceptance.
- Hybrid knowledge retrieval covers distinct sources before repeated chunks from a long guide, retaining bounded context and seven-game capability recall.
- The Agent preview shows acceptance items, active commands, recent results and actual ticks. Manual previews hide this panel.
- Manual Run reuses exact executable/capability consent from the current project and bounded trusted local approval history. Source, entity binding, ordering, capabilities or runtime-config changes require fresh consent; one-shot delivery and current-revision validation remain intact. Legacy records are reusable only for an exact script-set digest. Missing/rotated approval evidence falls back to explicit approval.

Native regression uses a generated fixture, not the user's unsaved game. It covers 40 grid clicks across orthographic/perspective cameras, camera movement and viewport resize, native object and background dragging, release outside the target, same-tick replay, cancellation, actual entity rotation and actual camera state. `docs/examples/drag-target.ts` is the validated generic example; it targets the preview's spherical camera, not arbitrary camera component configurations.

No running user application was restarted and no user project was rewritten. Existing generated cube gameplay still requires a controller repair using correct target lookup, layer membership/pivot transforms and actual camera control; the editor fixes do not silently rewrite an incorrect game algorithm.

Verification: final current-source capability capture passed 273 tests across 18 check groups, including 74 pointer-gesture/IPC/tool/retrieval tests. The final renderer Electron test also passed the unbound-script empty state, bound source preservation, approval reuse and progress/exit flows.

The required root `npm run check` passed contracts, type checks, boundaries, pinned candidates, 59 quick evaluations, capability census, builds, engine docs and 33 behavior tests. It stopped in workspace checks (4 pass, 1 fail): `apps/ai-studio/test/split-layout.test.mjs:69` expects UI 0.1.3, while the existing HEAD app dependency is UI 0.1.4. Both are unchanged by this task. Later root agent-tool/logic/integration stages were not reached; the capability capture above independently exercises the changed tool, script, retrieval and preview paths. No full-root success is claimed. See `verification.json`, `capability-final.log`, and `root-final.log`.
