# Incremental execution graph — 2026-09-15

Each conversation snapshot previously disposed all graph listeners/popovers and replaced the chat subtree. Hover restoration attempted to reopen the detail on a replacement node, but could lose the user's active panel.

The chat workspace and graph ancestors now remain connected. Within the same task, graph nodes and edges reconcile by stable ID, changing only affected text, attributes, geometry or status beams. Event handlers resolve the latest graph. Unrelated updates retain the exact detail DOM, text selection, expanded artifact sections and viewport state. Changes to the inspected node refresh its detail inside the existing open popover, preserving scrolling and expanded sections. Filtering out/removing its node unbinds the trigger; switching tasks or disposing the panel releases the graph lifecycle.

Verification:

- `node --test packages/studio-shell/test/*.test.mjs packages/studio-shell/test/resources/*.test.mjs packages/studio-shell/test/advanced-editor/*.test.mjs`: 74 passed.
- `node --test apps/ai-studio/test/graph-ui-electron.test.mjs`: passed in an independent Electron window. Tests compare actual node, edge, canvas, viewport, beam, popover and detail DOM identities during streamed updates; the unchanged node has zero DOM mutations. Also covers additions/removals, pinned detail updates, filtering/unbinding, text selection, expanded sections, nonzero scroll/zoom, keyboard navigation, session continuity, view switching and cleanup.
- Shell and application builds passed. The running user's application was not restarted.

`retained-detail.png` shows the detail still open after other nodes were updated, added and removed.

Repository `TMPDIR=/private/tmp npm run check` passed contract/type checks, boundary checks, upstream/candidate checks, protocol checks and 59 evaluation tests, then stopped at the existing M14 capability census `stale verification input binding` assertion. The current input digest remains `sha256:bf00db15ccfa9dc2cdcff7479ac3c7d9e00b29a5f05bb9f6e13c6e34b3558007`; the stale report expects `sha256:6bc1dd56c6701ac7cfcc73bdc94ffee1469f6a4431d64edef47fe5336c3df763`. The baseline was not recaptured or bypassed.
