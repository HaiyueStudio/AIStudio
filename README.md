# Haiyue AIStudio

AIStudio is the private AI-native game-editor product repository. The M06 POC is contract-first: the root
Harness/Cordis plugin tree, backend adapters, operation log, editor services, tools, and renderer UI remain separate
workspaces with one lifecycle owner.

Current status: the M06 POC is complete. The Electron product is the full local Agent experience; an additional browser shell
supports local scene authoring with browser storage and explicitly disables process-owned Agent backends.

Run the desktop app with `npm run test:electron -w ./apps/ai-studio`. Open Electron DevTools from **View → Toggle Developer
Tools** (F12), or set `HAIYUE_OPEN_DEVTOOLS=1` to detach DevTools after startup.

Run the browser shell with `npm run dev:web -w ./apps/ai-studio`, then open `http://127.0.0.1:4173/web.html`. The Web shell
supports New/Open/Save, History, hierarchy, Cube/Empty creation, Transform editing, WebGPU rendering, browser-local structured
logs, and trusted preview for JavaScript function-body scripts. Codex App Server and API-key Agent backends remain desktop-only
because browser code must not own local processes or secrets.

Run `npm run check` for the G01 contract, boundary, upstream-pin, and fake protocol-spike gates.
Run `npm run editor:candidate:check -- --milestone-file <absolute-M03-milestone.json>` to verify M03 completion and the four
vendored public package candidates. AIStudio owns its Scene product adapter; it does not consume the private M03 Scene Editor.
The full gate is `npm run g01:check -- <absolute-M03-milestone.json>`.

Start with `docs/adr/0001-agent-backends-and-root-lifecycle.md`, `docs/architecture/contract-index.md`,
`docs/security/threat-model.md`, and `docs/evidence/poc-fixtures-and-plan.md`. The current M03 compatibility gate is recorded in
`docs/architecture/m03-public-seam-audit.md`.
