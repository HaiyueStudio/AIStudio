# M12 G04 verification

- Prompt profile `prompt:game-authoring-general@3.0.0` is snapshot-tested by module version and digest. A production-source bias scan rejects genre-specific global patches.
- Every turn receives readable CAS artifact ids; empty legacy callers are upgraded to an explicit no-project context bundle before backend execution.
- Same-revision live follow-ups use reference-only project transmission; revision changes use nested delta artifacts and report reused bytes; restart reconstructs the same summary/context digest but deliberately starts a new provider session.
- Harness leaves unreported cached/reasoning tokens unknown. Codex reuses a live thread and does not issue a second `thread/start`.
- Seven canonical game requests preserve their own request tail while sharing exactly one prompt profile. The machine-checked comparison report is `evals/evidence/m12-g04-prompt-comparison.json`.
- Secret canaries are tested across request, project artifact, summary, prompt/log persistence and exported bug bundle. Hidden chain-of-thought is neither accepted nor stored.
- The checked comparison records a `1126B` stable prefix, `8688B` cold prompt, `5694B` same-revision warm prompt, `3090B` of delta reuse, and equal pre/post-restart context digests. Provider-reported hits remain `null` because no provider supplied hit evidence.
- `npm run m12:g04:check`, `npm run m12:g03:check`, `npm run m12:g02:check`, `npm run m12:g01:check`, and root `npm run check` passed on 2026-08-25. Tests use isolated fake transports and do not issue real provider requests.

Re-run with `npm run m12:g04:check`, then `npm run check`.
