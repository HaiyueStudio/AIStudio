# M13 G09 candidate verification

Implementation binding: `m13-g09-2026-09-02`  
Formal Goal gate: `npm run m13:g09:check`

G09 now has a deterministic SessionOp-derived Execution Graph, a lossless human Transcript, product topology UI, model-aware context pressure and manual compaction control, and restart-safe request identity. The complete formal gate, including the secure Electron process test and retained screenshot, passed on the current binding.

## Executable evidence

| Requirement | Evidence |
| --- | --- |
| deterministic replay | `execution-graph.test.mjs` rebuilds shuffled prefixes, independently hashes canonical semantics, and checks gaps/dangling references |
| causal graph | linear, overlapping parallel reads, transaction, evidence, approval, compaction, and outcome-unknown fixtures assert exact node/edge mappings |
| lossless Transcript | graph tests map message artifacts and system operations; the context UI integration proves message count is unchanged after Surface replacement |
| real durable compaction | `execution-graph-context-ui.test.mjs` runs five turns through `StudioConversationHost`, captures Context Frames, compacts at a safe boundary, replays the compaction, and rejects duplicate request ids |
| restart replay | the same test disposes and recreates the host over the same Operation Log and Session runtime, asserting identical graph digest and cross-restart request idempotency |
| product UI | `conversation.test.mjs` renders the topology, pressure, complete record and accessible list, then dispatches one typed compaction intent |
| large graph | 1000 tool nodes project under 1500 ms; overview layout stays below 100 visible nodes and 100 ms; expanded layout stays below 1500 ms |
| browser candidate | Chromium rendered the real bundled Shell UI with Graph↔Transcript round-trip, keyboard navigation, idempotent compact action and assistive hierarchy; measurements and screenshot hash are in `m13-g09-browser-evidence.json` |
| formal Electron | Electron 43.5.1 rendered the same graph with renderer sandbox, context isolation and web security enabled; it passed graph/transcript/keyboard/idempotency/accessibility and 1000-tool assertions and retained `m13-g09-execution-graph-electron.png` |
| unknown data | the product header and cost card display provider cost as `unknown` with its reason; cost-unknown is a real graph filter |

## Current candidate result

The refreshed in-app Chromium run passed every product assertion with no stale `running` node after turn completion. It measured 20.8 ms for the product render, 274.3 ms for 1000-tool projection, and 2.4 ms for overview layout on this host.

The first Electron attempt was made inside the nested `CodexSandboxOffline` execution identity while it inherited the `Administrator` profile. That SID/profile mismatch prevented DPAPI and Chromium sandbox child startup and surfaced as `STATUS_DLL_NOT_FOUND`; it was a runner boundary, not a G09 renderer failure. Re-running the unchanged secure fixture in the Windows host user session reached the product. A second real defect then surfaced: a fully hidden Windows window could reject `capturePage` with `UnknownVizError`. The fixture now calls `showInactive`, waits for two animation frames plus a bounded paint interval, rejects an empty image, and reports the exact failed stage. The focused Electron test and the complete `npm run m13:g09:check` gate both pass, and the PNG hash is bound in `m13-g09-browser-evidence.json`.
