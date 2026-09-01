# M13 G03 verification

Implementation binding: `m13-g03-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

The Goal gate is `npm run m13:g03:check`.

| Requirement | Authoritative evidence |
| --- | --- |
| model-aware usable capacity | pressure tests subtract output/safety reserves and retain `unknown` when the selected binding has no capacity |
| 65/75/80/92 states | exact boundary fixture checks all five states |
| 79% vs 80% | 79% returns `not-required`; 80% produces a completed automatic attempt |
| manual entry and UI data | manual fixture runs below 80% and asserts range, target, before and after fields |
| stable protected range | latest request is protected; open turn/tool/batch/approval/question defers publication |
| pinned facts and exact references | active goal, revision, acceptance, blocker and artifact references are digest-bound inside the structured summary |
| two-phase durability | every successful attempt has requested/started/summary-created/completed; failures have requested/started/failed |
| rollback and cancellation | empty summary and abort fixtures retain the prior Surface generation |
| 55%-65% target | completed automatic records assert measured after pressure inside the required band |
| restart recovery | published summary completes without a second summarizer call; unpublished work fails closed |
| repeated long-session compaction | two generations complete while append-origin Transcript remains byte-identical |
| ContextFrame and emergency | 80% ContextFrame preparation invokes automatic compaction and binds the resulting exact Surface generation; unresolved 92% pressure blocks the new model request |
| lifecycle | overlapping work is rejected and disposal aborts/drains the owned attempt before teardown |
| app reload | app-level test closes/reopens Operation Log and rebuilds Surface, Transcript, compaction record and ContextFrame |

Passing G03 does not claim provider-native compaction, provider Session/cache reconciliation, Scene diff routing or product graph UI. Those remain G04, G05 and G09 responsibilities.
