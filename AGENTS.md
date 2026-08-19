# Haiyue AIStudio repository instructions

- Use Node.js 22.19 or newer. Keep every workspace private until a later milestone explicitly admits a public API.
- The product has one root plugin lifecycle/effect tree. `harness-bridge` is the only package that imports
  DeepSeek Harness or Cordis; other packages consume Haiyue contracts.
- Codex App Server wire types are owned by `agent-backends`; renderer and editor packages must not import generated
  Codex schemas or start child processes.
- Consume Engine, UI, and Editor only through versioned public package exports or reviewed candidate tarballs. Never
  use cross-repository relative imports, `file:../`, symlinks, or another repository's `src/`.
- All external payloads enter as `unknown` and are validated before use. Model output never mutates a Document directly.
- API keys, OAuth tokens, authorization headers, credential paths, and raw secret values must not enter projects,
  renderer state, structured logs, fixtures, process arguments, or exported bug bundles.
- Durable events and Document History have different ownership. Undo appends facts; it does not rewrite the operation log.
- Long-lived listeners, timers, workers, child processes, files, scenes, and GPU resources belong to a lifecycle scope;
  abort/dispose is idempotent and late results cannot write after teardown.
- Before changing a package, read its nested `AGENTS.md`, M06 `contracts.md`, `integration.md`, and the active Goal.
- Run focused checks first, then `npm run check`. Do not advance milestone status without all Goal verification.
