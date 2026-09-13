# Engine documentation sources

Read `guides.json` for Studio-specific composition, input, camera and verification semantics. These records previously lived inline in Electron's knowledge source loader. Both automatic bounded retrieval and explicit documentation reads now consume the same file through the generated corpus.

Public native API signatures come from the installed `@haiyue/engine` declarations and exports. Play signatures come from `studioScriptRuntimeDeclarations`; tool/component facts come from their registries. Do not duplicate these in guides or add game-specific prompt patches. Keep units, coordinate spaces and lifecycle semantics at the owning declaration when possible. Executable Studio examples live in the repository's `docs/examples` directory.

`npm run build` in this workspace generates `dist/engine-docs`. The desktop copies these read-only resources; they are not renderer code or initial model context. The corpus is checked by `npm run engine:docs:check` at the repository root.
