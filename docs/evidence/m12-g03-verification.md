# M12 G03 verification

- Provider-neutral model negotiation covers accepted, explicit degradation, rejection, and Codex model-list schema drift.
- The two production backend adapter classes are exercised with isolated fake transports; no provider request or credential is used. The smoke verifies effective model/reasoning wire parameters, normalized input/cached/cache-write/output/reasoning usage, and finish reason.
- Usage reconciliation covers delta, cumulative, duplicate, out-of-order, final, cancellation drain, and late terminal events. Tool records retain `toolCallId`.
- Pricing covers catalog drift, cached input, cache write, integer rounding, unknown model, actual amount, and subscription/API separation.
- Main-process integration proves a hard tool-call budget blocks the second tool before `prepare` and mutation; the task owner also arms and latches hard wall-time expiry.
- All seven canonical cross-genre evaluation reports include task/budget status and turn/tool usage links.

Run `npm run m12:g03:check` for the bounded G03 verification suite, then `npm run check` for repository-wide contracts, types, boundaries, and upstream pins.
