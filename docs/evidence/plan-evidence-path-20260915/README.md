# Plan evidence path and detail deduplication

The screenshot reports plan validation (`acceptance[7]`), not failed game execution. The assertion selects event-trace while using state evidence's gesture.interactions wrapper. The gesture state and event-trace producers expose the same retained pointer events at different paths.

Before presenting a proposed plan for approval, normalize only event-trace's known gesture.interactions prefix to interactions. Keep the evidence type, array index, comparison operator, expected value, label, category and required flag unchanged. Raw tool parameters remain unchanged in execution records. Unknown paths remain rejected; existing approved plans and historical failure records are not silently rewritten. Document both canonical paths in the plan schema and searchable verification guide.

In graph details, suppress a failure/cancellation/wait reason only if the rendered result already contains that explanation, accounting for Markdown tool headings and status labels. Preserve different causes, fallback messages and truncated-result details. Suppress a redundant overview when it repeats a visible result/reason. Safe Markdown rendering remains unchanged.

Verification:
- 73 unit regressions pass: plan policy, persisted evaluator semantics, detail text, execution graph and conversation.
- Real Electron graph UI passes: exact failure text occurs once, distinct failure reason remains visible, existing interaction/Markdown/layout tests pass. `detail.png` is a synthetic UI regression fixture.
- Tools, shell, orchestration and app built locally. No restart of the user's application or mutation of the open project.
- Root `npm run check` passed earlier gates, then failed at the existing M14 census `stale verification input binding`. The baseline was not recaptured to bypass verification.
