# M13 model-aware Context pressure and compaction

Implementation binding: `m13-g03-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

G03 builds on the G02 append-only Session and Model Surface. It is provider-neutral: a Backend binding supplies the selected model name and `maxInputTokens`; a pluggable estimator or provider-reported usage supplies current input usage. Provider-native compaction and remote Session reconciliation remain G04 responsibilities.

## Pressure policy

Usable input capacity is `maxInputTokens - reservedOutputTokens - reservedSafetyTokens`. Pressure is `usedInputTokens / usableInputTokens`; it is never inferred from prompt bytes.

| Ratio | State | Request behavior |
| --- | --- | --- |
| `< 65%` | `normal` | continue |
| `65%–<75%` | `warning` | expose warning data |
| `75%–<80%` | `preparing` | prepare range; do not auto compact |
| `80%–<92%` | `compact-required` | compact after a stable boundary |
| `>= 92%` | `emergency` | block a new model request until pressure is reduced |

When model capacity or usage is unavailable, ratio is `null`, state is `unknown`, and automatic compaction fails closed with `capacity-unavailable`. Existing tool and Document writes are not cancelled by the emergency model-request gate.

## Stable range and pinned facts

`ContextCompactionRuntime.preview` returns UI-safe before usage, target range, protected nodes and expected summary bounds without writing. The range is a contiguous Surface prefix of at least two nodes. It never crosses an open turn, tool, batch, approval or question, and the latest user request plus its following response tail is protected. Callers may add protected nodes for exact inputs owned by later Context Router Goals.

Pinned facts are redacted, bounded and content-digested before summarization. The runtime always pins the active goal, latest project revision, unresolved barriers and latest Document/evidence/evaluation artifact references; callers add acceptance, blockers, latest errors or exact Scene diff facts. The structured summary artifact contains the exact ordered pinned fact records. Replay checks those digests against the durable `CompactionRecordV1`.

## Durable two-phase publication

One attempt uses a stable compaction id and appends:

```text
compaction.requested
  → compaction.started
    → compaction.summary-created  (validated artifact + atomic Surface replace)
      → compaction.completed
    ↘ compaction.failed           (old Surface generation remains active)
```

The summary must be non-empty, bounded, smaller than its covered range, contain all pinned facts and—when automatic pressure started at or above 80%—produce measured pressure between 55% and 65%. Only the validated `summary-created` operation advances Surface generation. Failure or cancellation before publication records a failed attempt and leaves the previous Surface readable.

After restart, a published summary missing only `completed` is completed without rerunning the summarizer. A requested/started attempt with no published summary becomes failed and never advances the Surface. Concurrent attempts for one Session are rejected; disposal first rejects new work, aborts owned summarizers, drains their final Session write, and then completes.

## ContextFrame truth

`ContextFrameRuntime.capture` is the model-request preparation boundary. When paired with a compactor it first invokes the 80% automatic policy, then creates an immutable CAS manifest for the resulting exact Surface generation, validates every external input digest, calculates pressure against the active binding and records the latest completed compaction. The resulting `ContextFrameV1` and its evidence Session Op prove which Surface generation and input artifacts a model request saw. At emergency pressure capture is rejected before a new model request can start unless automatic compaction has already reduced pressure safely.

Compaction never rewrites Session Ops or append-origin Transcript. Repeated compaction changes only Model Surface generations; renderer or process reload reconstructs the same Surface digest, compaction history, ContextFrame and complete Transcript from durable truth.
