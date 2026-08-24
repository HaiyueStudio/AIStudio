# Studio contracts instructions

- Own stable ids, schemas, diagnostic envelopes, and provider-neutral types only.
- Do not import Harness, Codex, DOM, Electron, Engine, or Editor implementations.
- Any contract change requires fixtures for valid, invalid, unknown-version, and secret-bearing payloads.
- M12 v2 contract ownership is enumerated by `config/contracts/m12-contract-index.json`; keep TypeScript names, schema ids, fixtures, and consumers aligned without weakening M06 v1.
