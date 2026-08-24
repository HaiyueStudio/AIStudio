# Game authoring tools instructions

- Every tool has a versioned schema, effect/risk class, redaction policy, preview, and bounded result.
- Mutations require exact base revision and use the same Document/History service as manual editing.
- Do not register shell, network, arbitrary filesystem, package-management, delete-project, or delete-entity tools in M06.
- M12 tools consume the shared capability ids, component definitions, TaskSpec and Observation/Evaluation envelopes; tool descriptions cannot redefine their effect, risk, acceptance or budget semantics.
