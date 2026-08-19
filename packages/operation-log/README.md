# Operation Log

`@haiyue/ai-studio-operation-log` owns AIStudio's append-only local diagnostic
facts. It is not Document History and never rewrites an event for Undo/Redo.

## On-disk layout

The configured root must be an absolute directory under the desktop app's OS
user-data directory. Tests always use isolated temporary directories.

```text
<root>/
  journal/segment-000001.jsonl   checksummed source of truth
  index/events-v1.json           atomic, derived, rebuildable query index
  artifacts/sha256/<digest>.json immutable redacted JSON artifacts
  quarantine/<segment>.*         preserved partial or corrupt tails
```

Each journal line is written once, optionally `fsync`ed, and contains a
monotonic sequence, stable event/correlation ids, canonical payload digest,
provenance, redaction metadata, artifact references, and a checksum over the
whole record. An artifact must exist and pass its digest check before an event
may reference it.

Startup replays every retained segment. A final partial write is isolated and
reported as recovered; checksum, sequence, or schema corruption is isolated and
puts the service in fail-closed degraded state. Journal or quota failures also
disable mutation, trusted-code, and runtime-start through `OperationLogStatus`.

Rotation retires only complete oldest segments. The derived index is rewritten
atomically and can always be rebuilt from journal records. No persistent file
handle or timer is retained between calls.

## Query and export boundary

Queries accept exact kinds, fixed correlation fields, severity, time/sequence
windows, a limit of at most 200, bounded correlation traversal, and an opaque
query-bound cursor. There is no SQL, regular expression, or file-path input.
The headless `diagnostics.query` service returns safe summaries and reads only
explicitly approved content-addressed artifacts.

Bug bundles are manifest-first directories containing a bounded event page and
an allowlist of artifacts. All contents pass redaction a second time and are
listed with byte length and SHA-256; bundles are never uploaded by this package.

## Verification

Run `npm test -w ./packages/operation-log`. The suite covers concurrent append,
restart replay, partial/corrupt tail, old-schema read migration, cancellation,
disk-full injection, rotation/quota, bounded traversal/cursors, missing
artifacts, secret canaries across journal/index/bundle, and latency/growth/file
handle budgets.
