# Preview stop/edit and composite input — 2026-09-14

## Observed task

Read the current project-scoped journal and its redacted execution artifacts; did not edit the user project or restart its app.

- 2026-09-14 09:01:06 UTC: `play.stop` completed and returned `state: stopped` at document revision 9.
- 09:01:29 / 09:01:41 UTC: `script.apply` rejected before execution with `task.transition-invalid: Cannot enter editing from playing`.
- The generated controller defaults each pointer-down to its own `orbit` branch and changes to object manipulation only when a matching Engine interaction exists. Only the prototype body was configured for interaction after replication.
- Its `api.read.findAll('motionRoot')` cannot match actual names such as `Cubie_… · motionRoot`; the Engine API uses exact equality. The branch also selects the first nine returned entities instead of deriving a layer from hit geometry, and changes orientation without a shared-pivot positional rotation. These are authored-script defects; this change does not silently rewrite that existing game.

## Changes

- Confirmed stopped runtime results return active playing/validating tasks to editing. Evidence, repair attempts, terminal states and approval/revision guards remain intact. Active preview edits receive an actionable stop-required diagnostic; script proposals alone remain allowed.
- Repeated `play.stop` is idempotent and does not inspect a missing runtime or invent lifecycle evidence.
- Assembly inspection/approved-plan validation detects replicas missing or differing from the prototype pointer configuration, reporting affected part ids. Inspection additionally reports potentially occluding unconfigured meshes for author review, without guessing that every such mesh is an error.
- Worker validation warns about literal exact-name lookups absent from the current scene. This remains a warning because intentional runtime-created entities can be valid. Warning summaries are visible in script proposal results. Scene context is omitted rather than treated as complete when beyond its bound.
- On-demand documentation clarifies explicit stable-id bindings, decoration hit policy, gesture ownership, group-pivot rotation and authoritative transform/camera verification.

## Verification

- Focused lifecycle/assembly/script checks: 9 passed; final assembly recheck: 2 passed.
- Product state, recovery, acceptance and new stop/edit regression: 24 passed.
- Script proposal/apply/start approval separation and repeated cleanup: passed.
- Real Electron/WebGPU pointer regression: 40 grid clicks across projections, camera movement and resize, plus native object/background drag, captured drag outside targets, same-tick input, blur cancellation, composite child hits, opaque decoration failure reproduction and penetrable-decoration recovery. Object rotation preserves camera; background gestures change only the camera.
- All changed packages and app built successfully; git diff whitespace check passed.
- Root check again stopped at the existing M14 stale verification-input binding after earlier contract/type/boundary/candidate/eval checks. No milestone evidence was regenerated to bypass the gate.
