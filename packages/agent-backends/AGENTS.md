# Agent backends instructions

- Own Codex App Server wire schemas and backend-specific auth, process, stream, usage, and error adapters.
- Harness imports remain in `harness-bridge`; this package consumes the normalized bridge facade.
- Never read credential files or expose child processes, tokens, or provider payloads to the renderer.
