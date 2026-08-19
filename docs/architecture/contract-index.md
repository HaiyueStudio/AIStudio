# G01 contract index

Authoritative machine-readable contracts live in `config/contracts`; TypeScript declarations are a consumer aid, while JSON Schema
validates every persistence, backend and IPC boundary from `unknown`.

| Contract | Purpose |
| --- | --- |
| plugin manifest / profile / lifecycle effect | composition, config provenance and reversible ownership |
| durable event / operation-log query | append-only fact envelope and bounded Agent diagnostics |
| Agent backend descriptor / event | backend capability negotiation and normalized stream |
| conversation node | renderer projection for text/progress/question/plan/tool/approval/diagnostic/completion |
| tool definition / approval record | fixed effect/risk schema and exact one-shot authorization |
| project command | sole mutation request with exact document/base revision |
| project document / scene snapshot / script resource | immutable single-project POC state and trusted-script proposal |
| IPC message | versioned renderer-main allowlisted `studio:*` envelope |

Rules not expressible in JSON Schema remain runtime invariants: project revision equals embedded scene revision; `dirty` reflects
`revision !== savedRevision`; entity and script ids are unique; parent references are acyclic; scale is finite/non-zero; approval expiry
uses monotonic guards; prepared command and approval digest are recomputed immediately before commit. G02-G09 must add conformance tests
for these semantic rules without changing v1 wire shapes unilaterally.
