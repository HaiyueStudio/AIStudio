# Incremental execution records and stable reading position

2026-09-15. No live AIStudio restart or user project mutation.

The steps panel formerly replaced its full content and feed on every projection. Its follow-latest check only measured the inner feed, even when the outer steps panel owned the scrollbar. A non-scrolling inner feed was consequently treated as already at the bottom.

Changes:

- Retain the steps container, feed, attention list and cards keyed by conversation node ID. Insert new records, remove absent records, and update only changed cards. Streaming title/body changes patch text in place without recreating beams, disclosures or controls.
- Retain pending plan selections/feedback and unchanged task details. Persistent card callbacks route to the current dispatch function; render-level scroll listeners are aborted before rebinding.
- Auto-follow only when both feed and outer steps panel are near the bottom. While reading history, preserve the first visible card and its viewport offset, including updates that increase the height of earlier records.
- Preserve reading state across Graph/Steps switches and updates while the whole panel is hidden. The existing Latest button explicitly restores following. Sending a new message still follows the newly submitted turn.
- Release card caches, task caches and reading state on disposal. New read models remain authoritative for actions and status.

Verification:

- `node --test packages/studio-shell/test/conversation.test.mjs packages/studio-shell/test/execution-graph.test.mjs`: 50 passed (`unit.log`).
- Sandboxed Electron G09 suite passed (`electron.log`), retaining graph panning, selection, beams and viewport tests. New browser checks cover nested scroll ownership, append-only DOM mutation, card/disclosure identity, text patch identity, scroll anchors, latest following, pending plan input/focus preservation and one-shot dispatch, hidden views, and clearing records.
- Shell build passed. Final app build passed (`app-build.log`).
- `TMPDIR=/private/tmp npm run check` reached the existing M14 capability-census stale verification input binding failure (`root-check.log`). No baseline was regenerated and no milestone was advanced.
