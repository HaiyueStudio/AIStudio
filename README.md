# Haiyue AIStudio

AIStudio is the private AI-native game-editor product repository. The M06 POC is contract-first: the root
Harness/Cordis plugin tree, backend adapters, operation log, editor services, tools, and renderer UI remain separate
workspaces with one lifecycle owner.

Current status: M06 G01 architecture and compatibility baseline. No product runtime is implemented yet.

Run `npm run check` for the G01 contract, boundary, upstream-pin, and fake protocol-spike gates.
Run `npm run editor:candidate:check -- --milestone-file <absolute-M03-milestone.json>` to verify M03 completion and the four
vendored public package candidates. AIStudio owns its Scene product adapter; it does not consume the private M03 Scene Editor.
The full gate is `npm run g01:check -- <absolute-M03-milestone.json>`.

Start with `docs/adr/0001-agent-backends-and-root-lifecycle.md`, `docs/architecture/contract-index.md`,
`docs/security/threat-model.md`, and `docs/evidence/poc-fixtures-and-plan.md`. The current M03 compatibility gate is recorded in
`docs/architecture/m03-public-seam-audit.md`.
