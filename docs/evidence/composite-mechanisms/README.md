# Composite authoring mechanisms

Implemented in the existing tools, Document History, renderer and durable conversation pipeline. No user project was edited and the running AIStudio was not restarted.

- `studio.plan.propose.assemblies` records named required part roles, color separation and minimum total instances. Current model schema requires an explicit array; legacy plans without it remain readable. Approved declarations survive restart and are checked before preview validation and task evaluation. Bulk primitives cannot stand in for a declared composite assembly.
- `assembly.create` declares a parent-first blueprint, creates its motion root and complete prototype atomically, and stores a versioned assembly definition/binding in project settings.
- `assembly.inspect` reads real document hierarchy, geometry including normalized defaults, local transforms and effective material colors. It emits a digest bound to the actual prototype. Structural validity is not a visual verdict.
- `assembly.instantiate` validates the current prototype and inspection digest before applying any edits, supports per-slot color overrides, copies configured components, remaps internal entity references and returns actual root/part ids. The prototype is the first usable instance. Scripts must live on an external controller; script-bearing prototypes are explicitly rejected rather than silently copied with stale hard-coded references.
- Same normalized geometry is shared inside each editor/Play projection; caches have independent owners. Material definitions are grouped but mutable instance parameters remain independent. This is not draw-call instancing or live-linked prefab editing.
- Resource inventory groups identical geometry/material definitions and exposes proven use locations, stable content identities, bounded usage lists and copy-on-write grouping when an instance changes its geometry. Assembly registry contents are omitted from general scene settings context; the specific inspection tool provides bounded detail.

## Verification

- `regression.log`: 144 tests passed across runtime tools, tool discovery, resource catalog/workflows/budgets, scene authoring, plan validation, conversation rendering and durable task recovery.
- `replication.log`: 4 focused assembly tests passed on final implementation, including one additional test for pointer-component copying, stale inspection and normalized default-radius comparison.
- `context.log`: scene-context regression.
- `preview.log`, `preview.png`: isolated Electron window using production sandboxed Play renderer. Synthetic fixture renders three rounded bodies with independent colored face parts; fixed-step input, same-tick state/PNG capture and teardown pass. The image was visually inspected. This is not a live Luna generation evaluation.
- `root-check.log`: full repository check was run. Its final result is recorded verbatim; an existing M14 verification-input binding mismatch prevents an all-green repository gate. Milestone records were not rewritten.
- `build.log`: final desktop application build.

The new mechanism cannot infer omitted visual requirements with certainty. Semantic planning and multi-angle visual review remain necessary; declared structure is now checked against actual authored data instead of generated script counters alone.
