# Assembly resource query regression

The reported `editor/resources` requests failed with `behavior.secret-or-accessor`.
The production resource adapter validates a complete behavior source before building
the resource catalog. Assembly creation persists an ordinary `prototype` data field
in `document.settings['studio.assemblies.v1']`. The shared JSON validator rejected
that field name, so every resource category failed as soon as an assembly existed.

The validator now permits `prototype` as an own JSON data property and copies that field
with `Object.defineProperty`. Accessors, secret fields, `__proto__`, `constructor`,
non-plain live objects and the existing depth/byte limits remain rejected/enforced.
Existing projects need no document migration. The resource panel also distinguishes
a failed read from an unopened project in its empty-list message.

The production IPC regression creates an assembly, queries it before replication,
creates 26 additional instances, checks one shared geometry/material with 27 proven
uses, locates a use, reads all five categories and repeats after save/reopen. It
reproduced the reported diagnostic before the fix. Separate validator regression
covers prototype data round-tripping, stable source binding, nested secret fields,
getters that must never execute, and prototype-pollution inputs.

No user project was modified and the running AIStudio was not restarted for this fix.
This is a production adapter/IPC fixture, not a new live model generation test.

Validation: `regression.log` records 22 passing checks on the final validator,
including production IPC, 1000 entities / 200 scripts, behavior analysis and worker
teardown. An earlier broad parallel run had 52 passes, two analysis timeouts and
one 45-second budget-test timeout (`parallel-regression.log`); all three affected
cases passed in the serial rerun without changing their timeout limits.

The final desktop build passed. The root `npm run check` passed contracts, type
checks, boundaries, upstream/candidate/protocol and M12 quick checks, then stopped
at the pre-existing M14 capability verification input-digest mismatch. Its recorded
digest begins `bf00db15`; the current expected digest begins `e50ca17f`. No milestone
record was rewritten to hide this gate (`root-check.log`).
