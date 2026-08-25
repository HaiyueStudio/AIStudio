# M12 G05 verification

Goal: `g05-game-document-v2-component-registry`

The machine-bound result is [`m12-g05-verification.json`](./m12-g05-verification.json), reproduced by `npm run m12:g05:check`.

Verified gates:

- Eight G05 public payloads are registered in the M12 contract index and validated from JSON fixtures, including invalid unknown operations and unbounded queries.
- Registry snapshots and capability manifests share one deterministic digest; plugin descriptors can register before the first snapshot and late mutation is rejected.
- Component CRUD, unknown version rejection, parent cycles, entity/component dependencies, atomic rollback, revision conflict, Undo, and Redo run through the production document/History path.
- The M06 v1 fixture preserves entity transforms/materials, settings, and script source in v2; backup, report, rollback, byte-stable reopen, and injected save-failure recovery are exercised.
- A single property edit at 1,000 and 10,000 entities copies 102 bytes, projects one unit, uses at most 206 history bytes, and remains under the 50 ms gate. Sparse queries scan at most 1,000 entries in this fixture.
- Scene authoring no longer exports a full GameDocument for normal create/update/delete operations; Engine projection receives deltas.

The implementation and tradeoffs are documented in [`m12-game-document-v2.md`](../architecture/m12-game-document-v2.md).
