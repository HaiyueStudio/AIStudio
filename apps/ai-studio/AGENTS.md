# AIStudio app instructions

- Own Electron main/preload/renderer composition and product profiles, not reusable domain contracts.
- Keep context isolation, sandbox, web security, navigation blocking, and versioned minimal IPC enabled.
- Main owns filesystem, secrets, and child processes; renderer receives only validated, redacted projections.
