# Agent orchestration boundary

`@haiyue/ai-studio-agent-orchestration` owns the headless product workflow previously implemented in the Electron app's `conversation-host.ts` and `legacy-session-migration.ts`. It can initialize, receive intents, emit validated projections and dispose without an Electron window.

The dependency direction is:

```text
apps/ai-studio (composition, IPC, platform adapters)
  -> agent-orchestration (conversation workflow)
     -> agent-runtime (provider-neutral turns, accounting, durable sessions)
     -> game-authoring-tools (tool policy, batches and document transactions)
     -> operation-log (durable evidence)
     -> studio-shell/conversation (headless read models and validation)
```

The new package separates the workflow host from plan validation and continuation (`plan-policy.ts`), wall-time and budget policy (`budget-policy.ts`), task acceptance/evidence/repair (`task-acceptance.ts`), bounded presentation (`conversation-presentation.ts`), retained-event queries, legacy migration and session recovery coordination. The host coordinates these policies using the existing runtime and rolling tool scheduler; it does not introduce another tool registry, scheduler or Document writer. Business prompts move with their policy unchanged.

The app composes `StudioConversationHost` with runtime, tools and log services from the existing root plugin scope. Project snapshots, exact scene queries, knowledge refresh and login handoffs are injected through `ConversationHostOptions`. The app registers conversation disposal before initialization so a failed activation releases any partially initialized conversation resources.

`ProjectConversationController` binds each host to one project's archive and drains it before switching editor authority. See [project Agent history](project-agent-history.md) for persistence, portable replay and viewer ownership.

`StudioSessionOrchestrator` consumes the runtime's existing `SessionRecoveryAuthorityPort` and a small `RecoveryClaimPort`. The app's `createWorkspaceRecoveryAuthority` maps editor History receipts to the runtime authority result. Its filesystem `RecoveryClaimStore` implements cross-process fencing. The orchestrator owns claim acquisition/release, durable recovery and audit; it never opens claim files or depends on `ProjectWorkspace`.

`studio-shell/conversation` is an explicit headless export of the existing projection models and validators. UI panels remain in studio-shell; neither renderer authority nor a parallel set of versioned contracts is introduced. Runtime, tools and projection modules must not depend back on orchestration or app code. `scripts/check-boundaries.mjs` enforces these directions for source imports and production workspace dependencies.

Validation: package tests cover recovery through injected ports, including contention, committed-but-unacknowledged recovery, authority failures and repeated recovery. Existing conversation, budget, task acceptance, migration, tool invocation and Electron integration tests consume the package's public export. Historical milestone evidence remains unchanged; active source checks follow the extracted modules.
