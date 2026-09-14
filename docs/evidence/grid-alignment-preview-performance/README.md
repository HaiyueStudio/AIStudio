# Grid alignment and preview/resource responsiveness — 2026-09-14

## Diagnosis

Read the current project’s durable texture and script call artifacts without changing project data. The board is an XZ plane scaled to 15 units. The 1024px recipe draws 16 lines at 16 + i * 64 (i=0..15), while the script consumes engine world hit points and snaps to 15 intersections at -7 + i. Texture interval is 0.9375 world units, logical interval is 1. The first texture line is -7.265625 along its positive UV axis. Both origin and interval disagree; a pivot-only adjustment cannot repair this. No replacement ray casting was present in that script.

The shipped placement example derives its grid from texture pixel bounds and surface size, and the searchable textured-grid-alignment guide explains count-1 intervals, UV axes, transforms and visual/behavior verification. The existing game has not been rewritten. For its 15-unit board and -7..7 script grid, the matching 15 pixel centers would run from 34.133333 to 989.866667 with interval 68.266667; alternatively, rebuild both from one agreed layout.

## Changes

- Analysis frame retention and composite PNG use half the render canvas width and height, rounded to positive integers. The displayed game and normalized input space are unchanged. HUD composition uses the corresponding output scale, and state/pixel capture retains the existing same-tick guard.
- Resource queries clear old items and detail immediately and display loading. Another tab can supersede a pending query; app-owned abort and generation guards ignore late results. Errors retain the current project/category context.
- Product catalog opts into exact source-binding cache of resource rows and document references. Project/source changes, refresh, file inspection health changes and disposal invalidate the appropriate state. Failed reads retry. Source binding hashing is memoized by immutable document revision and registry digest in the app adapter.
- Resource enrichment no longer blocks the Agent preview/approval handoff queue. Run and approval buttons show immediate pending feedback and disable duplicate actions. Script validation, authorization, journal durability and GPU initialization still run; no universal startup latency claim is made.

## Verification

- Resource cache/lifecycle: 7 passing tests, including project/revision invalidation, explicit refresh and retry. Fixture measured about 911ms for the cold query and 666ms total for five warm category queries (one reference request). These are fixture timings, not measured user-project latency.
- Production IPC, docs, conversation and graph: 68 tests covered; 67 initially passed. The example’s zero-vs-negative-zero assertion was corrected and its focused rerun passed. No runtime tolerance or product validation was relaxed.
- Actual Electron resource panel passed existing workflows, 1000 entities/200 scripts, accessibility and the new pending-list assertions. The final rerun also verified rapid Texture → Material switching before a pending query finishes, empty loading lists, and late failure isolation across a project switch.
- Actual paused Play screenshot passed PNG 197x426 from a 393x852 canvas, same-tick state, HUD and cleanup. The old fixture could advance beyond input tick 1 before pause; it now uses the supported paused start for determinism.
- Actual engine native-pointer regression passed 40 clicks across center/corners, resize, camera movement and both projection types, plus object/background drag and capture/cancel cases.
- Final application build passed. Root checks passed contracts, TypeScript, boundaries, upstream/candidate checks and all 59 evaluation tests, then stopped at the pre-existing M14 stale verification-input binding gate. Milestone evidence has not been rewritten. The new detailed guide is an on-demand studio-reference document rather than an eager legacy knowledge guide; the seven-game retrieval comparison passed after this separation.

The current user application was not restarted and user project files were not edited.
