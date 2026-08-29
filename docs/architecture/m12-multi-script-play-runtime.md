# M12 multi-script Play runtime

G09 replaces the single selected-script preview with one project-level Play owner. `preview.validate` prepares every enabled committed script by default; an explicit `scriptIds` list is available only as a bounded diagnostic subset. The order is deterministic: persisted script order first, script id second. A script set is limited to 128 entries and one enabled script per entity.

## Authorization boundary

Validation completes for the whole selected set before authorization. `PreviewPlan` binds the document id and revision, selection mode, ordered per-script id/entity/order/text revision/source digest/capabilities, aggregate capability union, fixed-step tick rate/max-substeps/seed, and an aggregate SHA-256 script-set digest. Renderer disclosure removes `emittedText` from every script. Approval creates a short-lived one-shot grant; any document change, settings change, expiry, set mismatch, consume, or service disposal revokes it.

## Runtime ownership

The standalone sandboxed iframe owns one Engine scene and installs all authorized scripts in plan order. Each `ScriptComponent` receives only its own capability view even though the Engine executor is configured with the aggregate union. A runtime error uses `disable-script`, identifies the exact script/entity, and leaves sibling scripts running. Hot reload targets one script id and replaces only that resource and execution scope.

Stop, restart, failed start, and iframe unload cancel input/physics/effects first, then remove and destroy script owners in reverse order before destroying the Engine scene. Script timers and listeners are counted across scopes and must reach zero after cleanup. The authoring document remains immutable throughout Play.

## Product flow and verification

Manual Run, Agent `preview.validate`, Electron IPC, browser host, renderer broker, and iframe messages use the same multi-script plan. The independent Play page retains pause/resume/device simulation while state acknowledgements now include the script set and per-script state.

Run `npm run m12:g09:check`. Unit coverage proves stable order, explicit subsets, one-shot/stale authorization, targeted hot reload, sibling fault isolation, reverse cleanup, and per-script capability filtering. The Electron WebGPU smoke runs two scripts in the actual sandboxed product iframe, injects a fault into only the leader, observes the follower continue, and verifies zero residual disposables.
