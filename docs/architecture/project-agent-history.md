# Project Agent history

Each saved project owns `.aistudio/agent/`. `project-history.json` binds the archive to its project ID; `journal/` contains append-only structured journal records, and `artifacts/` contains integrity-checked JSON values addressed by their content digest. The archive includes conversation projections, execution records, durable Session operations and referenced evidence. Project archives do not automatically evict old segments.

An `agent/execution-record` journal event carries `AgentHistoryRecordV1`: item ID, project ID, item kind, status, session/turn IDs, tool ID, start and finish timestamps, duration in milliseconds, and the artifact containing its data. That data preserves tool parameters and the actual result before the model-facing summary/digest projection. Text, progress, plan, approval, question, diagnostic and completion items use the same record envelope. Updates to an item append facts; the viewer groups them by item ID and displays the latest state. Original updates remain in the journal.

The existing Operation Log redaction and artifact validation apply before project writes. Credentials and hidden reasoning are not part of the execution record. Large data stays in artifact files rather than being truncated into a two-kilobyte UI summary. The viewer fetches a selected record through a project-bound IPC request and renders JSON as plain text.

## Ownership and project transitions

- `operation-log/ProjectAgentHistory` owns filesystem persistence, project manifests, artifact replication, portable imports, legacy adoption and paged reads. A scoped log port tags conversation writes with the bound project ID. Runtime events join the same archive through their durable Session identity; unrelated global or late events cannot be attributed to whichever project happens to be open.
- `agent-orchestration/ProjectConversationController` owns the transition: cancel and drain old work, flush its records, release its host, then initialize the next project's scoped host. It preserves model/budget settings, uses unique IDs across host instances and keeps the outer replay revision monotonic.
- The Electron app supplies the workspace identity, directory and recovery adapters. Project replacement waits for the old host before replacing Document authority; Save As relocates an unsaved archive without restarting its host. Filesystem locations never come from renderer requests.
- `studio-shell/AgentHistoryViewer` presents the paged execution-record tab. Project changes abort outstanding reads and clear the view; stale results are discarded. The user can expand any item to inspect parameters, return values and timing.

Unsaved projects use an editor cache keyed by project ID. The first project save copies the archive into the project directory, then future writes continue there. Copying a project directory to an editor with an empty cache imports its journal and nested artifacts idempotently before Session replay; history therefore does not depend on the original editor installation.

Existing global records are adopted only when their project can be proven by explicit project correlation or a durable Session creation record. Old summaries are marked as legacy records, with unavailable parameters/results/timing left unknown. Unassigned historical records remain in the global journal. Import and archive creation validate the project binding, supported record versions, artifact integrity and filesystem symlinks; they do not rewrite Document History or rerun tools.

## Verification

Project archive tests cover isolation, complete result data, secret redaction, pagination, portable import, nested artifacts, idempotency, first save and legacy ownership. Conversation tests exercise real durable Sessions, A → B → A replay, preserved settings, long messages, tool timings and late results during project replacement. Viewer tests cover paging, plain-text details, schema rejection and stale responses after a project switch. Shared schema fixtures include valid, invalid, unknown-version and secret-bearing records.

Run `npm run project-history:check` for the focused storage, conversation, IPC and real Electron viewer checks. Interrupted steps retain their original parameters when recovery or cancellation updates their status.
