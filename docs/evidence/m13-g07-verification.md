# M13 G07 verification

Implementation binding: `m13-g07-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

Formal Goal gate: `npm run m13:g07:check`.

The current-tree gate is required to rebuild every touched package and execute the full Editor Plugins, Agent Runtime, Game Authoring Tools and desktop Host/restart suites before the formal matrix verifier. Exact suite totals are reported by the gate rather than copied into this document.

## Proven in the current tree

| Requirement | Executable evidence |
| --- | --- |
| atomic batch mutation | Game Tool transaction fixtures commit 2, 7 and 100 members as one revision, one History entry and one receipt |
| no partial Scene | invalid member application and a before-History injected failure retain revision 1 with no transaction History entry |
| prepare validation | stale base and invalid member operations are rejected before a transaction plan, commit lock, Scene revision or History entry exists; disjoint members prepare concurrently from one frozen revision |
| revision CAS | a racing command between prepare and commit rejects the transaction and leaves only the racing edit visible |
| durable receipt/idempotency | duplicate commit returns the byte-identical receipt and final Scene digest; one committed idempotency key cannot be aliased by another transaction; after-receipt and after-ack faults never create a second History entry |
| receipt and diff authority | each new receipt binds a content-addressed `GameDocumentDeltaV2`; missing/corrupt receipts or mismatched/missing diff artifacts fail closed; undo/redo preserve the original receipt and expose separate delta provenance |
| outcome reconciliation | Editor fixtures distinguish not committed, committed and advanced-without-receipt ambiguous states |
| receipt discovery | Agent Runtime discovers a committed transaction from member identity when transaction coordinates did not reach Session |
| pre-start/pre-commit recovery | a durable node plan makes crash-before-`tool.started` resumable; unchanged base revision after prepare is classified not committed and safe to re-prepare |
| post-ack recovery | crash after the existing Session commit projection but before tool completion reuses the commit fact and synthesizes exactly one missing completion |
| recovery at-most-once | dual-host fixture runs two coordinators concurrently and observes one authority query and one synthesized completion |
| fair effect locks | lock fixtures cover disjoint overlap, FIFO conflicts, idempotent release, cancelled waits and the global barrier; owners labelled with different batch/turn identities still serialize component/script conflicts, and trusted/runtime conflicts do not interleave |
| product transaction path | Conversation Host submits one consecutive mutation group to `executeTransaction`, retains provider result order and appends one `document.committed` Session fact |
| durable approval | desktop restart fixture persists an unresolved approval, reconstructs the pending projection, accepts it after restart and resumes exactly once |
| trusted/runtime Electron restart | two actual Electron processes prove `script.apply` trusted-code and `preview.start` runtime-start approvals remain pending, actionable and resolved exactly once after restart |
| long user wait | existing Host regression waits beyond the former hard wall-time, excludes waiting time from active usage and completes after approval |
| composer ownership | Shell projection keeps the composer available across durable barriers; Host queues a new prompt and cancels only the superseded live wait |
| provider release | plan, mutation approval, backend question and budget fixtures all observe zero active provider calls while waiting and continue in a fresh bounded turn |
| cross-process fencing | a child process holds the Session recovery claim, a live contender defers, and the parent takes over only after the owner process exits |
| failure evidence retention | one product fixture commits a transaction, captures state and PNG screenshot, records evaluator results and estimated cost, refuses budget continuation, restarts, and proves every item plus the receipt remains identical |
| transaction observability | coordinator metrics cover prepare/commit/reconcile/lock wait latency, stale revisions, ambiguous outcomes and duplicate prevention; lock metrics cover conflicts and cancelled waits |

The machine-readable matrix enumerates 36 crash, transaction, idempotency, lock, recovery, barrier, artifact and metrics cases. `pendingProductProof` is empty only because each formerly listed product proof now has executable evidence in the formal gate; source-text matches alone are not counted.

## Safety properties

- The model cannot supply transaction identity, risk or lock classification as authority.
- Prepare never mutates the document.
- A commit has exactly one Workspace/History owner.
- Commit-time cancellation after a possible write enters reconciliation; it is not reported as an ordinary rollback.
- An advanced document without a matching receipt is never retried automatically.
- Barrier requests and resolutions are checkpointed before their renderer projection can be considered authoritative.
- Existing artifacts, committed work, evidence and normalized usage/cost are not deleted when a later member, budget continuation or recovery step fails.

## Gate composition

The formal gate runs contract and boundary checks, full Editor Plugins, Agent Runtime and Game Authoring Tools suites, rebuilds the desktop application, runs batch/legacy/barrier restart Host regressions, and finally validates the implementation/evidence bindings and matrix coverage.
