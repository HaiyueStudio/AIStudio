# M12 threat-model increment

Binding：`m12-g01-2026-08-24`  
Parent：[`M06 POC threat model`](./threat-model.md)

M12 adds automated Play input, screenshot/state artifacts, component adapters, task budgets, cost reporting, cache reuse and bounded repair. The M06 controls remain mandatory; this document only lists new or materially expanded threats.

| ID / STRIDE | Attack | Required control | Residual / verification owner |
|---|---|---|---|
| M12-T01 prompt/task injection / E,T | Project text, imported asset metadata, playbook or screenshot analysis asks the model to reveal secrets, widen permission or ignore acceptance | Every context artifact has source/digest/redaction; policy and tool effect remain out-of-band; hidden oracle never becomes model-visible; playbooks are allowlisted and content addressed | G04 prompt-injection fixtures; G02 oracle leak scan |
| M12-T02 visual artifact confusion / S,T,I | A stale, wrong-viewport, oversized or secret-bearing screenshot is attributed to the current Play instance | Persist-before-reference; bind task/turn/play, document revision, script digests, tick/frame, viewport/device and producer version; enforce byte quota and redaction before model access | G10 mismatched provenance and secret-canary tests |
| M12-T03 automated input abuse / E,D | Replay injects OS-global keys/pointer events, escapes viewport, runs indefinitely or continues after Stop | Input targets only the owned Play instance; normalized allowlisted controls; fixed tick and max event count; no OS automation; abort/stop invalidates pending replay | G06 containment, cancellation and rapid-input tests |
| M12-T04 trusted-script grant replay / E | `allow-always` or a prior approval starts different scripts/document/runtime later | Grant binds task, exact script-set digest, document revision, runtime config, capabilities and expiry; trusted-code/runtime-start remain exact approval domains; lifecycle teardown revokes grants | G09 stale/expiry/script-set mismatch tests |
| M12-T05 physics backend object escape / E,D | Agent obtains mutable Rapier/Box2D World/body handles, unsafe callbacks, NaN values or unbounded simulation | Component schema only; finite bounded values; runtime adapter owns backend; event/query results are immutable and bounded; fixed-step limit and teardown residue checks | G07 schema fuzz, NaN, backend cleanup and collision-load tests |
| M12-T06 cost/cache misrepresentation / S,R | UI invents currency amount, reports estimated as actual, or claims provider cache hit without provider evidence | Versioned pricing catalog; actual/estimated/unknown states; unknown requires null amount/currency/formula; local CAS, context delta, eligible and provider-reported hit are distinct records | G03 contract and pricing fixtures; G12 report-integrity gate |
| M12-T07 unbounded repair / D,E | Agent repeats the same mutation/evidence loop, consumes unlimited cost or silently expands tools/permissions | TaskBudget hard limits for time/token/tool/turn/repair/observation; hash attempt args and evidence; no-change repeat stops; budget exhaustion forbids further mutation; permission cannot auto-expand | G10 repeated-attempt and every-limit tests |
| M12-T08 cache poisoning/cross-project leak / S,T,I | Content digest is forged or an artifact from another project/task is reused under an identical logical id | Digest verified over canonical bytes; artifact includes source/project/document revision and redaction policy; namespace and retention isolation; provider prefix cache never treated as trusted state | G04 corruption, cross-project and eviction fixtures |
| M12-T09 component adapter escalation / E | A component claims a lower risk/effect or selects an arbitrary runtime adapter | Registry—not request—owns effect/risk/schema/adapter; unknown type/version/capability fails closed; adapter catalog is bundled and versioned | G05 registry spoof and unknown-version tests |
| M12-T10 observation/log flood / D,I | State, trace, screenshot or performance capture exceeds task quota or exposes arbitrary binary/path | Observation byte budget, bounded projection, approved artifact ids, no arbitrary path, quota-aware retention and redaction | G10 oversized artifact and quota recovery tests |

## New invariants

- Automated input can affect only the current Play owner and has no desktop/OS automation capability.
- Screenshot or state evidence without exact provenance is unusable for acceptance, even if the bytes are valid.
- `unknown` cost and unreported provider cache hit stay unknown; UI wording cannot upgrade evidence quality.
- No repair step executes after any hard limit; stopping preserves evidence and produces a blocked result.
- Component values are data. Live backend, World, GPU, DOM, filesystem and network objects never cross the adapter boundary.
