# M12 physics and gameplay runtime

G07 projects Engine physics into AIStudio as immutable authoring descriptors plus a Play-owned runtime. The document stores only backend-neutral world, rigid body, collider, material, joint, character, and ground-probe values. Stable entity ids bind joints and observations. Box2D/Rapier objects and all opaque handles remain inside Engine systems.

## Ownership and failure behavior

- `PhysicsPlayRuntime` owns the Play-only systems, backend worlds, bodies, colliders, joints, contact buffers, and script projection. Stopping Play removes and destroys these owners before the Engine scene is destroyed.
- Box2D is supplied by the pinned Engine candidate. Rapier loads asynchronously under the serialized world timeout and the Play abort signal. Failure, timeout, stop, or a late completion cannot install a world after ownership has ended.
- A body requires a matching rigid-body/collider pair and exactly one compatible world. Missing worlds, duplicate worlds, stale material/joint ids, mixed dimensions, unsupported backends, and invalid non-uniform curved-shape scales fail closed.
- Backend handles are excluded from the GameDocument, renderer payloads, tool results, script API, state hashes, diagnostics, and logs.

## Fixed-step and events

Play advances physics at the document simulation tick rate. Each backend emits contact starts/stops; the Engine systems synthesize `enter`, `stay`, and `exit`, classify collision versus trigger, sort pairs deterministically, and cap the Studio projection at 1,024 events per tick. Queries return Engine entities internally and stable document ids at the script boundary.

Character movement applies bounded velocity changes before the physics tick. Jumping requires a ground probe backed by the real Box2D AABB or Rapier shape query; it never substitutes renderer bounds or a fake AABB collision model.

## Determinism contract

Exact hash boundary: a replay using the same pinned Engine candidate, backend, architecture, initial document, seed, and 60 Hz tick must produce the same per-tick Play state hash. The projection includes stable-id body observations, velocities, grounded state, sorted contact events, runtime resource status, and scene transforms.

Backend handles are excluded, as are Wasm allocation ids, wall-clock load duration, renderer/GPU state, and object identity.

Semantic tolerance boundary: when comparing supported host architectures rather than the identical runtime, position error is at most `1e-4`, linear/angular velocity error is at most `1e-3`, and an equivalent contact phase may differ by at most one fixed tick. A comparison outside these tolerances is a failure and is not hidden by rounding the exact state hash. Box2D 2D and Rapier 3D are separate semantic domains and are not treated as interchangeable simulations.

## Script projection

Scripts that reference `api.physics` receive the `physics` capability and generated declarations. The bounded API can inspect bodies/events/grounding, set velocity, apply force or impulse, wake, teleport, stop, hit-test, raycast, and overlap. It operates only on Play entities and cannot mutate authoring descriptors.
