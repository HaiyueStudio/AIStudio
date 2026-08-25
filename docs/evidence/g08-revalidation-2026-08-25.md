# G08 conversation, approval, and log UI revalidation — 2026-08-25

Status: complete. The product renderer now uses the shared conversation and structured-log projections, approval expiry fails closed, and conversation replay survives an application restart without persisting raw or secret-shaped content.

## Requirement audit

| Requirement | Current evidence | Result |
| --- | --- | --- |
| Backend selector, connection/auth state, model/reasoning/budget controls | Shared `ConversationProjector` and chat panel remain the only renderer projection path; Studio Shell conversation tests cover backend identity-only auth handoff, controls, effective settings, cost and cache explanations | Pass |
| Text, progress, question, plan, tool, approval, diagnostics, usage/cost, terminal and unknown nodes | Normalization/presentation tests cover all known nodes plus bounded unknown and injection-shaped fallbacks | Pass |
| Send, cancel, retry and reconnect use typed intents | Controller and IPC validation tests reject ambiguous or spoofed intents; renderer only forwards typed intents | Pass |
| Approval disclosure and lifecycle | Cards show tool/version/target/effect/risk/argument summary/diff/base revision/digests/scope/expiry; expired approvals stay visible but cannot block the composer or dispatch a decision | Pass |
| Stale/pending work is terminalized on teardown | Conversation host cancels active runs and converts pending/streaming replay nodes to terminal cancelled/stale projections before disposal | Pass |
| Live and restart replay are identical | `g08-conversation-restart.test.mjs` reopens the real Operation Log and asserts the same final `ConversationProjector` node projection | Pass |
| Durable replay contains no raw secret | Conversation nodes are stored as redacted content-addressed artifacts; a secret-shaped canary scan of the entire operation-log directory is clean | Pass |
| Full structured LogViewer in the actual product surfaces | Electron and Web HTML mount the shared viewer with severity/kind/session/turn/tool/entity/plugin filters, paging, health, correlation expansion, safe copy and bug-bundle export | Pass |
| Web log compatibility, filtering and correlation | Web host upgrades legacy raw SHA-256 digests to the canonical `sha256:` form, emits safe summaries with redaction counts, implements bounded cursor/filter queries and attaches project/document correlation | Pass |
| Real DOM interaction | In-app browser loaded `web.html`, created a cube, refreshed logs, expanded two correlation IDs, filtered to `scene/entity-created`, and triggered `Copy safe summary` | Pass |
| Teardown and late async work | Conversation poller, viewport, LogViewer subscription/controller and conversation projection are disposed; Shell tests prove stale query and late completion cannot write back | Pass |
| Renderer trust boundary | Root contract/type/boundary/upstream/protocol checks and renderer bundle verification pass; no raw log payload, secret, filesystem path or process primitive is exposed to the renderer | Pass |

## Completed gates

- `npm test -w @haiyue/ai-studio-shell`: 15/15.
- Focused AIStudio G08 restart/security plus IPC, G10 integration and bundle tests: 15/15.
- `npm run typecheck -w @haiyue/ai-studio`: passed.
- AIStudio production build and renderer bundle verification: passed.
- Full AIStudio suite: 24/26 passed. The two Electron-process smokes are blocked by this Windows host, not by a product assertion: Electron `safeStorage` cannot reach OS encryption, and the Electron GPU process exits with `0xc0000135`. The same built Web renderer passed real in-app-browser DOM acceptance.
- Root `npm run check`: contracts (35 schemas, 33 valid and 22 rejection fixtures), TypeScript, boundaries, upstream pins/schema and protocol spikes passed.

## Revalidation fixes

1. Replaced the simplified product log list with the shared `LogViewerController`/`renderLogViewer` implementation in both desktop and Web surfaces.
2. Added cancellation-aware IPC bridging and complete renderer teardown for the LogViewer.
3. Persisted normalized conversation projection nodes as immutable redacted Operation Log artifacts and restored them through bounded paged replay.
4. Added explicit approval scope/expiry read models and disabled expired actions at both presentation and controller layers.
5. Repaired Web safe-log shape, legacy digest migration, filtering, paging, diagnostics and correlation metadata.

G08 is accepted with the Electron-host limitation recorded above; no G08 functional or security requirement remains open.
