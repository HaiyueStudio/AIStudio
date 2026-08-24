# Script preview instructions

- Project scripts are trusted-project code, not an untrusted-code sandbox.
- Validation, capability disclosure, explicit authorization, isolated Play ownership, and teardown are required.
- Do not add arbitrary Node, DOM, network, package, or filesystem capabilities.
- M12 Play ownership is multi-script, fixed-step and observation-aware; runtime data crosses boundaries only through registered components and ObservationArtifact, never live Engine/backend objects.
