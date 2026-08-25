# M12 shared contract index

Binding：`m12-g01-2026-08-24`

机器真值为 [`config/contracts/m12-contract-index.json`](../../config/contracts/m12-contract-index.json)，TypeScript owner 为 [`packages/studio-contracts/src/m12.ts`](../../packages/studio-contracts/src/m12.ts)。JSON Schema 全部位于 `config/contracts/schemas/m12-*.schema.json`。

| Contract | Owner | Primary consumers |
|---|---|---|
| `M12CapabilityId` | G01 | G02–G10 |
| `AgentTurnConfigV2`, `BackendCapabilityNegotiationV2` | G03 | G04, G11, G12 |
| `UsageRecordV2`, `CostRecordV2`, `TaskBudgetV2` | G03 | G10–G12 |
| `ContextArtifactV2` | G04 | G10 |
| `ComponentDefinitionV2`, `GameComponentInstanceV2`, `GameDocumentV2` | G05 | G06–G10 |
| `GameDocumentOperationV2`, `GameDocumentBatchV2`, `GameDocumentDeltaV2` | G05 | G06–G11 |
| `GameDocumentQueryV2`, `GameDocumentQueryResultV2` | G05 | G10–G11 |
| `ObservationArtifactV2`, `TaskSpecV2`, `EvaluationResultV2` | G10 | G02, G11, G12 |

## Version policy

- v1 M06 contracts remain valid until their explicit migration owner ships and rollback evidence passes.
- v2 external payloads enter as `unknown` and pass the matching JSON Schema before conversion to TypeScript types.
- Unknown schema versions and capability ids fail closed. Oversized values fail before persistence or model visibility.
- Contract fields are provider neutral. Harness and Codex adapters only map supported provider fields into negotiated effective values and diagnostics.

## Shared invariants

- Amounts cannot exist on an `unknown` cost record.
- Runtime/GPU/audio component definitions require a stable runtime adapter owner.
- Screenshot and visual observations require viewport and device provenance.
- A rejected Backend negotiation has no effective configuration and contains at least one diagnostic.
- A passing evaluation cannot report a hard-exceeded budget.
