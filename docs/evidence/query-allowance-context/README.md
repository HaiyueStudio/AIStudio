# Query allowance confirmation context

2026-09-14. Query-count confirmation now includes the visible task request, current task phase, approved plan title when available, an excerpt of this turn's public assistant message, and the actual query and scope. No model-private reasoning is read or inferred. With no public explanation, the question says that no separate reason was provided and shows the factual search instead.

Documentation counts are explained as matching entries, with bounded pages rather than simultaneous full-text reads. Existing expand/cap choices and per-task allowance rules remain intact. Parallel searches coalesced into one allowance question contribute their query context. The complete displayed prompt is persisted through the existing question projection, so replay/restart preserves it without adding a second persistence mechanism.

The card is titled 查询额度确认. Paragraph line breaks are retained, long words wrap, and the previous nested paragraph height cap is removed; the existing bounded attention list provides scrolling.

Validation covers public-explanation / missing-explanation cases, exact query/scope, cap behavior, parallel query context, durable restart, replay rendering and HTML-shaped text safety. `confirmation.png` is an isolated real Electron window using the production shell renderer and application stylesheet with representative task facts; it does not depict a live user task. The user's running AIStudio and project were not restarted or changed.

Final checks: 43 focused tests passed; 1 isolated Electron window passed and was visually inspected; application build passed. The root check passed its contract/type/boundary/candidate/protocol/M12 quick stages and stopped at the existing stale M14 acceptance input binding. No generated acceptance record was manually replaced.
