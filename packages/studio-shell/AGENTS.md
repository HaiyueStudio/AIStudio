# Studio shell instructions

- Renderer components display read models and emit typed intents only; they do not execute tools or own approval policy.
- Never import child-process, filesystem, secret-store, raw journal-writer, Harness, or Codex protocol modules.
- Unknown conversation nodes and diagnostics require a safe visible fallback; never render arbitrary model HTML.
