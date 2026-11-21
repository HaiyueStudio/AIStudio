# Haiyue AIStudio

AIStudio is the private AI-native game-editor product repository. The M06 POC is contract-first: the root
Harness/Cordis plugin tree, backend adapters, operation log, editor services, tools, and renderer UI remain separate
workspaces with one lifecycle owner.

Current status: the M06 POC is complete. The Electron product is the full local Agent experience; an additional browser shell
supports local scene authoring with browser storage and explicitly disables process-owned Agent backends.

Use Node.js **24.9 or newer** (the pinned development version is 24.21.0). For npm 12, install with
`npm ci --allow-remote=all --cache .npm-cache` (the lockfile retains integrity-bound historical mirror URLs).
Initialize the desktop binaries with `node node_modules/esbuild/install.js` and `node node_modules/electron/install.js`;
run `node node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs` for the native spawn helper.
The current reviewed upgrade uses Codex 0.171.0 with GPT 6.2 Astra/Sol, Harness 0.2.2-rc.5 / Cordis 4.1.0,
Engine 0.2.3 and a UI 0.2.3 candidate. Candidate identities are pinned in `config/upstream` and `config/engine-candidate.json`.

Build with `npm run build -w @haiyue/ai-studio`, then run the desktop app with `npm start`.
On macOS the launcher creates a locally signed development app in `.cache/desktop` so native notifications work;
allow HaiYue AIStudio notifications in System Settings when prompted. This is local development signing, not a distribution release.
`npm run test:electron -w ./apps/ai-studio` builds and uses the same launcher. Open Electron DevTools from **View → Toggle Developer
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
