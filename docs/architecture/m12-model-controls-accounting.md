# M12 model controls, accounting, and budgets

G03 uses `AgentTurnConfigV2` as the provider-neutral request and requires every backend to return an explicit accepted, degraded, or rejected negotiation result. Harness maps the effective reasoning level into its pinned model selection; Codex maps it into `thread/start` and `turn/start`, disables provider fallback, and fails closed when the pinned `model/list` response drifts.

Provider usage enters a per-turn append-only ledger. Delta and cumulative events are reconciled by stable event id and sequence, while late usage may update accounting after terminal completion without reviving execution. Tool input and output bytes create records carrying `toolCallId`. Operation-log records contain counts, stable coordinates, effective configuration, and digests only; raw provider payloads, credentials, and billing identity are excluded.

Task accounting aggregates the latest turn records, applies the versioned pricing catalog, and keeps `actual`, `estimated`, and `unknown` distinct. Codex subscription limits are displayed as limits and deliberately produce unknown API cost. A hard budget latches permanently and every tool call is reserved before preparation or mutation. Late usage can tighten the latch but cannot reopen it.

The conversation UI exposes backend-advertised model and reasoning choices, output limits, all task-budget dimensions, and a task cost card with provisional/final state, cache savings, usage, enforcement state, and unknown-cost explanations.
