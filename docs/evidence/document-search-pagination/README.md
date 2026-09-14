# Documentation search argument and pagination repair

2026-09-14. The reported tool call already contained `cursor` and `requested` when received from the provider (project journal sequence 866); preparation added the configured `limit` but did not remove a query. No `query` had been supplied.

The failed cursor decoded to a query binding of `handsame:chainedCacheDocAnnotation` and offset 1, rather than the SHA-256 query binding issued by the documentation store. Renaming `requested` to `limit` alone would still leave a missing query and an invalid cursor. The preceding successful page used a different, valid cursor. This is a model-generated pagination request, not a changed documentation bundle or lost query during allowance processing.

## Change

- Search results include `nextCall: {toolId, arguments: {continueFrom: resultRef}}`, or null at the end. Pagination retrieves the frozen query, surface, applied limit, byte budget and cursor from the stored response.
- Model-facing search schema has distinct new-query / stored-page modes and no raw cursor property. Legacy explicit query+cursor calls remain supported internally.
- A continuation cannot override query, surface, limit or cursor. Expired, cross-instance, fabricated and end-of-search references return explicit diagnostics without guessing another query.
- Query allowance handling leaves continuations intact; it must not inject a new default limit. Allowance response metadata explicitly says it is not an argument object and directs documentation pagination to `value.nextCall.arguments`.
- Invalid initial requests explain the correct `query`/`limit` fields and the continuation route.

## Validation

Focused coverage uses the actual documentation corpus and tool runtime: continuous pages, no duplicate/missing rows, byte bounds including nextCall, unchanged effective limit, response mutation isolation, invalid/expired/cross-instance references, and normal prepare/execute boundaries. Host tests cover allowance and recovery, including preservation of continuation arguments.

See accompanying logs for final results. Existing app preferences-path fixes are outside this change. The user's active app/project was not restarted or edited during this repair.

Final result: 35 focused tests and 9 catalog/invocation tests passed; application build passed. `npm run check` passed its contract, type, boundary, candidate, protocol and M12 quick stages, then stopped at the pre-existing stale M14 capability verification input binding. The original acceptance record was preserved, not rewritten to claim a full pass. Current source input digest is recorded in verification.json.
