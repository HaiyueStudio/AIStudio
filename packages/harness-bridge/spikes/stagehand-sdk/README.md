# Stagehand client inference spike

This private, isolated package validates Stagehand 4.1.0 with the fixed rc.2 Harness Worker. It is not a production dependency or registered tool. Copy this directory to a temporary location before running `npm ci --ignore-scripts --no-audit --no-fund`; set `STAGEHAND_PROBE_CHROME` to a reviewed Chrome for Testing executable, then run `npm test`.

The tests run an actual browser/extension/Worker with fixture model responses and a local HTTP server. No API key is read. The small worker patch is checksum-gated. Host admission/settlement is a prototype seam, not a production budget ledger or provider adapter. See `docs/evidence/stagehand-sdk/2026-10-07/README.md` at the repository root for findings and remaining integration work.
