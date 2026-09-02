# M13 G04 verification

Implementation binding: `m13-g04-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

The Goal gate is `npm run m13:g04:check`.

| Requirement | Authoritative evidence |
| --- | --- |
| provider-neutral binding | `BackendSessionRuntime` writes only frozen `BackendSessionBindingV1` through `DurableSessionRuntime` |
| new/resume and concurrency | package fixture starts two concurrent ensure calls, opens one remote, then reuses the exact boundary |
| boundary confirmation | confirmed Studio op id advances generation without using provider history as truth |
| remote missing/reload | runtime and app fixtures close/reopen Operation Log, detect missing provider Sessions, append detach and rebind from the retained checkpoint |
| remote mismatch | wrong remote boundary detaches and creates a higher generation with a structured diagnostic |
| disconnect/stale | unavailable inspection preserves remote id, records stale once and does not open duplicates |
| failed rebuild | provider open failure leaves a detached binding and all Studio state; a later ensure succeeds |
| model capacity | unknown remains null; later provider context-window evidence updates the binding without reopening the remote |
| native compaction success/failure | an atomic-summary fixture flows through the G03 compactor into requested/started/summary-created/completed; provider failure invokes the explicit Studio fallback |
| pinned Harness compaction | Harness reports no public driver and unknown input capacity; output maxTokens is not reused as Context Window |
| pinned Codex compaction | Codex reports the transport but false safe mirror; tests prove `thread/compact/start` is not invoked without an auditable summary |
| cache semantics | local CAS hits, provider eligibility, provider reported tokens, unknown and unavailable are asserted independently |
| dual Backend contract | app reload fixture replays one Studio Session through Harness/Codex adapters with different capability projections |
| lifecycle | disposal rejects late work and drains an already-started provider open |
| package boundary | verifier rejects DeepSeek/Cordis imports in provider-neutral runtime and keeps Codex wire logic in agent-backends |

Passing G04 does not claim that current pinned Harness/Codex native compaction is safe: both bindings deliberately publish `nativeCompaction: false` and use G03 Studio compaction. It also does not claim G06 parallel scheduling merely because Codex transport advertises parallel tool calls.
