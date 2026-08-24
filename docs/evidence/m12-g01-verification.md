# M12 G01 verification

Binding：`m12-g01-2026-08-24`

## Requirement-to-evidence map

| G01 requirement | Authoritative evidence | Gate |
|---|---|---|
| Shared Agent/usage/cost/budget/context/document/component/observation/task/evaluation contracts | `config/contracts/m12-contract-index.json`, `packages/studio-contracts/src/m12.ts`, `config/contracts/schemas/m12-*.schema.json` | `npm run contracts:check`, studio-contracts typecheck |
| Valid/invalid/unknown-version/secret/oversized/unknown-capability fixtures | `config/contracts/fixtures/m12-contract-cases.json` | `npm run contracts:check` |
| Engine/Editor public capability classification and owners | `config/contracts/m12-capability-census.json`, `docs/architecture/m12-capability-census.md` | `scripts/verify-m12-g01.mjs` imports installed public exports and checks complete capability-id coverage |
| M12 threat increment | `docs/security/m12-threat-model-increment.md` | verifier requires M12-T01 through M12-T10 and shared binding |
| Seven-genre M06 baseline | `docs/evidence/m12-g01-baseline.json`, `docs/evidence/m12-g01-baseline.md` | verifier binds the exact reviewed M06 commit/tool inventory and rejects unsupported pass claims |
| Single owner / no parallel envelope | package `AGENTS.md`, `scripts/check-boundaries.mjs` | `npm run boundaries:check` |
| Same reviewed inputs | `config/contracts/m12-evidence-binding.json` | verifier requires one binding id and exact M06/Engine/Editor/AIStudio revisions or candidate manifests |

## Commands

```text
npm run contracts:check
npm run typecheck -w @haiyue/ai-studio-contracts
npm run boundaries:check
node scripts/verify-m12-g01.mjs
npm run m12:g01:check
npm run check
```

## Review note

G01 freezes contracts and records evidence; it does not implement G02–G11 runtime features. `available-public` in the census means a public package seam exists, not that the Agent can use it. The M06 baseline is deliberately blocked at capability preflight because the reviewed M06 revision cannot produce fixed-step input/state/screenshot acceptance evidence.

## Verified result

Verified on 2026-08-24:

- `npm run m12:g01:check`: PASS — 12 shared contracts, 35 capability rows, 7 baseline genres, one evidence binding.
- `npm run contracts:check`: PASS — 28 schemas, 27 valid fixtures and 17 invalid fixtures across two fixture manifests.
- `npm test -w @haiyue/ai-studio-contracts`: PASS — build and package contract test.
- `npm run check`: PASS — repository typecheck, boundary, upstream pin and protocol spike gates.
- `git diff --check`: PASS; Git only reported the repository's configured LF→CRLF checkout notices.
