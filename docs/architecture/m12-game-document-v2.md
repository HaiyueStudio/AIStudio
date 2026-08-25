# M12 GameDocument v2 and Component Registry

G05 replaces the legacy scene snapshot setting with an authoritative, versioned document containing scenes, entities, components, scripts, assets, settings, revision metadata, and migration provenance.

## Mutation path

UI services and future Agent tools submit the same `GameDocumentBatchV2` operation list through `ProjectWorkspace.executeBatch`. One batch enters Editor History as one command. The store validates the complete result atomically, returns a generated inverse delta, and increments the revision once. A failed operation rolls the whole batch back and does not enter History.

Component property edits clone only the selected component value. They do not export or rebuild the full document. Scene authoring consumes document deltas and calls the Engine projection's incremental `apply`; `rebuild` is reserved for document replacement, including open/migration.

Queries return at most 1,000 entities and scan no more than 10,000 entity-index entries per call. Their opaque cursor represents the next index position, so sparse filters remain bounded and resumable.

## Registry lifecycle

`studio.component-registry@2.0.0` is provided by the project workspace plugin. Plugins may register exact type/version descriptors during activation. The first registry snapshot or project read model freezes the registry, producing a deterministic digest and capability manifest for the project session. Unknown type/version pairs, unsupported schema vocabulary, extra instance fields, invalid defaults, and oversized values fail closed.

Each descriptor owns its JSON schema, defaults, validation budget, effect/risk, editor metadata, serialization policy, capability, runtime adapter identifier, and test owner. This lets G06–G08 add camera, physics, rendering, asset, and effect descriptors/adapters without changing the core GameDocument schema.

## Migration and recovery

Opening schema v1 deterministically maps primitive/light entities and script resources into v2. Before replacement it writes a byte-identical `.haiyue-project.v1.backup.json` and a digest-bound `.haiyue-migration-v1-to-v2.json` report. Save uses a temporary file plus rename. Reopen/save is byte-stable, `rollbackMigration` restores the original source, and an injected rename failure leaves the authoritative v1 file unchanged.

Machine verification: `npm run m12:g05:check`.
