# M14 G05 behavior flow implementation

This document describes the G05 implementation. Independent verification and its frozen input binding are recorded in `m14-behavior-flow-acceptance.md`.

## Ownership and data

- `script-preview/behavior` analyzes the existing G02 input and instruments derived executable text. It observes the actual public Engine compiler invocation and the production declarative runtime snapshots. It does not write script resources or Document History.
- `ProjectBehaviorController` in agent-orchestration binds structure, explanations and Play owners to the current project. It cancels stale work, deduplicates language-specific explanations, validates cumulative captures and coordinates artifact publication. A bounded set of prior Play owners accepts the old realm's final Stop capture during a restart without replacing the new overlay.
- `ProjectBehaviorHistory` in operation-log stores bounded chunks and their index in the existing content-addressed artifact store. Each published journal fact references every chunk. The existing `ProjectAgentHistory` replicates these facts to `.aistudio/agent` and imports portable records when a project is reopened. No additional journal, Session, registry or Document writer is introduced.
- The app supplies the workspace snapshot and registry, public-package versions, shipped preview bundle digests and existing service lifetimes. IPC routes read requests and attaches observation data to an already consumed preview plan. G04 tools consume the same authoritative source callback.

The ephemeral runtime plan is a compiler/owner index, not another persisted domain envelope. Capture ingress validates it against the existing `BehaviorManifestV1`, seals `BehaviorTraceV1` and produces the existing `ObservationArtifactV2` association. Runtime source digests come from the G02 document binding; they are not confused with the older preview digest that also hashes script capabilities.

## Observation semantics

The approved script text is transpiled with the existing preview compiler options. Instrumentation is admitted only when its original emitted text exactly matches the consumed approval plan. The Engine receives a function with the same seven arguments, preserved directive prologue, receiver/assignment semantics, short circuit evaluation and return value. No additional capabilities or Promise handlers are added.

Function entries, conditions, loops, calls, await resumes, returns and throws are recorded only at their actual execution points. A synchronous function returning a Promise does not establish that Promise's completion. Ambiguous duplicated source ranges (for example multiple static finally completion paths) are left uninstrumented. Overlapping invocations of the same node have no claimed per-invocation duration. Condition observations report truthiness and nullishness rather than assuming every operator chooses branches by Boolean coercion.

For expressions, `node-enter` means evaluation reached that expression; `node-exit` means evaluation completed. In particular, reaching a call expression does not prove that its callee ran if an argument subsequently throws. Instrumented function-body entry proves actual function invocation. The UI must preserve that distinction when describing observed nodes. Engine error callbacks also record asynchronous runtime failures using fixed redacted diagnostics.

Declarative timer observations require the runtime's actual `fired` result. Rule/action completion observations require a matching `firedRules` entry emitted after that rule's action batch succeeds. Final state is sampled after timer and rule observations; collection sequence is not a fabricated sub-tick action duration. Actual physics events retain entity ownership and a null internal node. Registered adapter references identify registry-to-shipped-bundle provenance and keep their internal control flow unknown.

Captures contain at most 10,000 events and remain below the existing 4 MiB trace limit, with explicit omission metadata. State samples have individual and aggregate limits. Secret-bearing/non-JSON samples are rejected before copying and produce only a fixed diagnostic. Saturated buffers count further omissions without serializing every dropped row.

Stop, hot reload and clock reversal close the recorder, and late callbacks cannot publish new rows. A replay loaded after simulation has advanced closes the old trace with `clock-reset`; it cannot silently continue the old observation. A newly started approved Play gets a fresh owner and generation. Replay verification compares identical input on fresh owners and checks actual fixed-step event ticks. This does not claim that resetting a clock restores an already-mutated world. Project revision/source/configuration changes invalidate current overlays and source locations. Historical artifacts remain readable without applying stale script ranges.

## Logic view and navigation

`studio-shell/panels/logic` displays independently loaded structure, explanation and trace. It owns only DOM presentation, selection, search, grouping, bounded paging, zoom and disclosure state. Cross-entity target nodes are included only through actual edges. Concurrency comes from explicit G02 edges; visual placement is not execution evidence. The expanded native dialog preserves keyboard focus and works at 375 pixels.

Script navigation revalidates the current binding in the service, checks the browser-visible exact script digest and selects its recorded source range. Component navigation displays the actual component and JSON pointer value; adapter navigation identifies the registered adapter and leaves internal execution unknown. Derived views do not edit the Document. Existing source-linked operation events, transaction IDs and artifact references are read from the current project's journal through bounded queries; association does not establish branch causation.

History pages reuse the existing journal cursor. A project switch clears old UI data; old structure remains read-only and cannot apply locations to newer source. Multiple Play artifacts can be viewed over a matching manifest while each record retains its Play identity and current/historical label.

## Current verification

Focused tests cover AST execution semantics, real asynchronous resumes, bounded/redacted capture ingress, cumulative prefixes, project binding, cancellation, record reread and portable journal replication. Production source/IPC tests cover both zero-script timer/rule gameplay and mixed gameplay through the existing authorization and public Engine compiler seam. The existing Electron product smoke now requires a real script observation to reach project persistence while Play is paused.

Additional checks now exercise the actual product's structure → explanation → exact script/component/adapter source → approved Play → observed trace → project history flow, repeated after renderer reload. The seven-genre corpus contains preserved M12 project documents, with original source paths and file digests; analysis and all recorded script ranges are checked without inventing genre-specific prompts. It verifies behavior browsing, not completion of M12 gameplay or online backend acceptance. Historical G01–G04 acceptance records remain unchanged.
