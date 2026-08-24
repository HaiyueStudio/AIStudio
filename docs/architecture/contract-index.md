# G01 contract index

M12 v2 的唯一共享契约索引位于 [`m12-contract-index.md`](./m12-contract-index.md)，机器真值为 [`config/contracts/m12-contract-index.json`](../../config/contracts/m12-contract-index.json)。v1 M06 契约继续作为迁移输入，不得由后续 Goal 原地改写。

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
`revision !== savedRevision`; entity and script ids are unique; parent references are acyclic; scale is finite/non-zero; pending approvals
have no wall-clock timeout and remain bound to their exact operation; prepared command and approval digests plus the document/base revision are
recomputed immediately before commit. G02-G09 must add conformance tests
for these semantic rules without changing v1 wire shapes unilaterally.
