# G09 Agent game-authoring tools revalidation — 2026-08-25

Status: complete. The shared tool runtime, coordinator, product conversation host and both real Agent backends pass the current controlled-authoring acceptance.

## Requirement audit

| Requirement | Current evidence | Result |
| --- | --- | --- |
| Fixed versioned catalog with closed inputs, effect/risk, capabilities, redaction, presentation, timeout and result budgets | 14 `1.0.0` tools are registered. The original 13-tool POC surface remains intact; `material.set` is a narrow public Engine-material extension. No delete, arbitrary component/file, shell, network, package, Git or export tool is present | Pass |
| External calls validate before policy or editor access | Bounded JSON-tree validation rejects cycles, non-finite values, excessive depth/nodes/text, unknown envelope/argument fields, duplicate enums, malformed diagnostic kinds, hallucinated ids and versions | Pass |
| Observe returns immutable bounded projections without live owners or paths | Project/scene/entity/script projections are immutable and budgeted; diagnostic pages expose only safe summaries, range, scanned count, canonical digest and query-bound cursor | Pass |
| Durable call fact precedes policy and preview | Correlated facts are now ordered as `call-received → pre-policy-passed → preview-prepared → approval → execution`; preparation failures receive a terminal fact without raw arguments | Pass |
| Exact approval binds call/session/turn/tool/version/document/revision/args/preview/target/expiry | Approval read models contain every binding and default to a five-minute expiry; expired or revision/digest-stale decisions are durably invalidated before execution | Pass |
| `allow-always` is narrowly scoped | Grant digest includes document, backend session, tool/version/effect/risk and target. Only reversible edits can use it; trusted code and runtime start expose and accept one-shot approval only | Pass |
| Same-document mutation serialization, timeout and late-result rejection | Concurrent same-revision edits enter the editor service one at a time; the queued call becomes stale. Timeout and cancellation produce terminal failures, and late results are rejected even when an injected runtime ignores `AbortSignal` | Pass |
| Mutation, trusted code and runtime fail closed when logging is unavailable | Every non-observe fact is required. Read-only tools can degrade; a journal append failure before mutation prevents editor entry | Pass |
| Manual UI and Agent use the same Document/History service | Manual `SceneAuthoringService` and Agent `entity.create` produce equivalent serialized entity state, revision and undoability. Editor batch/History rollback and save/reopen suites pass | Pass |
| Script proposal/apply and preview validation/start remain separate | Invalid module scripts cannot reach apply; apply and preview start require different exact approvals; preview uses the G06 one-shot broker and injected renderer-owned runtime control | Pass |
| Tool, approval, Document and History share correlation across restart | Deterministic command ids connect Tool facts to `document/command-*`; a closed/reopened real Operation Log traverses the complete chain | Pass |
| Completion reports actual work and incomplete items | Product completion summary contains every safe tool fact, result status, before/after revision, History label, preview result and blocker/diagnostic list | Pass |
| Coordinator validates provider payloads and owns cancellation | Malformed provider arguments are returned as structured failures rather than coerced; coordinator disposal aborts active backend turns and is idempotent | Pass |
| Same catalog works through both real backends | User-authorized DeepSeek Harness and Codex App Server each executed the same `entity.create` and `transform.set` mutations without substituted results | Pass |

## Completed gates

- `game-authoring-tools`: 23/23 deterministic tests.
- `studio-shell`: 16/16 tests.
- `editor-plugins`: 19/19 tests, including atomic batch rollback, History Undo/Redo, save/reopen and group cancellation.
- Focused AIStudio integration/security/restart/IPC/profile tests: 15/15.
- AIStudio production build, TypeScript and renderer bundle verification: passed.
- Root `npm run check`: 35 schemas, 33 valid fixtures, 22 rejection fixtures, TypeScript, boundaries, upstream pins and protocol spikes passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.

## Real backend acceptance

| Backend | Model / effort | Actual completed tools | Final state | Credential persisted |
| --- | --- | --- | --- | --- |
| DeepSeek Harness | `deepseek-v4-flash` / `low` | safe `project.snapshot`, then `entity.create`, `transform.set` | `completed`, document revision 3, one cube at `(1,2,3)` | No |
| Codex App Server | `gpt-5.6-sol` / `low` | `entity.create`, `transform.set` | `completed`, document revision 3, one cube at `(1,2,3)` | No |

The DeepSeek read-only self-check was accepted because the write-operation assertion remains exact: the only non-observe calls were `entity.create` and `transform.set`. Neither backend called script, preview or any additional mutation tool.

G09 now satisfies the shared-tool, approval, History, logging, cancellation and dual-real-backend completion conditions.
