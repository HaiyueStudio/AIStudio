# M12 G07 verification

Goal: `g07-physics-gameplay-components`

The machine-bound result is [`m12-g07-verification.json`](./m12-g07-verification.json), reproduced by `npm run m12:g07:check`.

Verified gates:

- Eleven versioned, serializable physics/gameplay descriptors cover 2D/3D worlds, bodies, colliders, materials, joints, character control, and ground probing.
- The pinned candidate exposes backend-neutral physics and replaceable backend seams. No backend handle crosses the authoring, script, event, or evidence boundaries.
- Seeded platform-jump, racing, and shooter fixtures execute against Rapier/Box2D and verify landing/jumping, collision, CCD trigger `enter/stay/exit`, stable ids, and exact same-candidate state hashes.
- Stale joint ids and backend load failures fail closed. Cancellation prevents late backend installation. Stop/restart leaves zero worlds, bodies, colliders, joints, and contacts, without mutating authoring data.
- `api.physics` is inferred, capability-filtered, and type-declared for bounded observation, queries, and runtime body commands.

The ownership, failure, state-hash, and tolerance contracts are documented in [`m12-physics-gameplay.md`](../architecture/m12-physics-gameplay.md).
