# Resource panel incremental rendering — 2026-09-15

Resource cards reconcile by catalogEntryId within a project. Existing rows and canvases stay attached; results insert, reorder, remove or patch only the affected resources. Loading and query errors retain the last list. Project changes still clear content immediately, invalidate action tokens and abort obsolete thumbnail work.

Thumbnails compare visual inputs, excluding the instance document revision. Changed images render into a staging canvas and commit only if their request is still current. Label-only changes, selection, and equivalent query results do not start new thumbnail work. Unchanged details retain DOM, expanded disclosures and focus. Background queries keep cards available for browsing and no longer show the busy status message above the list.

Verification:

- `node --test packages/studio-shell/test/resources/model.test.mjs`: passed.
- `node --test apps/ai-studio/test/resources/panel-electron.test.mjs`: passed with real services and sandboxed Electron. Added DOM identity, zero unchanged child mutations, loading retention, selection/detail/focus/scroll, label/configuration changes, unrelated revision, reorder/add/remove, errors, late thumbnail completion, project isolation and disposal assertions.
- `node --test apps/ai-studio/test/resources/thumbnails-electron.test.mjs`: passed with actual Engine mesh previews, shaded materials and controlled PNG decoding; see `thumbnails.log` and `geometry.png`.
- The combined run in `electron.log` passed the panel regression but exposed an older thumbnail assertion assuming exactly two card children. The existing shared-resource use count is now explicitly allowed; the final thumbnail rerun passed.
- Shell and app builds passed; `app-build.log` records the final app build. No live app restart or user project changes.
- `TMPDIR=/private/tmp npm run check`: reached the existing M14 capability census stale verification input binding failure; see `root-check.log`. No verification baseline was regenerated and no milestone status changed.
