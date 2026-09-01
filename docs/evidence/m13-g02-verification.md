# M13 G02 verification

Implementation binding: `m13-g02-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

The Goal gate is `npm run m13:g02:check`.

| Requirement | Authoritative evidence |
| --- | --- |
| create/open/append/flush/replay/fork/dispose | `packages/agent-runtime/test/g02-session.test.mjs` exercises every public lifecycle path against a real temporary Operation Log |
| deterministic prefix replay | 25 retained prefixes reproduce identical Surface digests after process restart |
| Surface append/replace generation, range, source and digest | two consecutive replace operations survive restart; invalid range is rejected before persistence |
| complete append-origin Transcript | four original messages remain byte-identical after two replaces and restart |
| stable checkpoint and Backend binding projection | checkpoint digest/boundary is recomputed on replay; fork proves Backend bindings do not become child truth |
| reload and truncated write | app-level renderer/process reload and a quarantined partial journal tail rebuild from durable data |
| open turn/tool recovery | effectful open tool becomes outcome-unknown, is never retried, and ends in an interrupted checkpoint |
| long approval | approval barrier and open turn survive reload without timeout or crash conversion |
| fail-closed inputs | unknown Studio event, duplicate op, bad range and semantically corrupt fork seed are rejected |
| lifecycle ownership | disposing rejects late calls; Session flush and backend disposal both run under plugin ownership |

Passing G02 does not claim automatic 80% compaction, provider native session recovery or parallel tool scheduling. Those remain G03, G04 and G06 responsibilities.

