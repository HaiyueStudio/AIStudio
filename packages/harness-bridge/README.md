# Harness bridge

This package is the only AIStudio boundary allowed to know DeepSeek Harness or
Cordis runtime types. It owns one Cordis root and adapts it to the stable
`StudioKernelHost` contract.

The pure resolver in `@haiyue/ai-studio-kernel` computes the deterministic
profile plan. This bridge executes that plan and owns plugin fibers, services,
contributions, durable/live event listeners, reversible effects, cancellation,
rollback, and resource accounting. The M03 editor foundations are installed as
one scoped provider in the same root; they do not create another plugin host or
History owner.

## Current upstream

The runtime now uses Harness `dsh-v0.2.0-rc.2` and Cordis `4.0.4`.
See [the upgrade record](../../docs/upstream/deepseek-harness/README.md) for the exact pin,
stream/session adaptations, model capacities, pricing assumptions and regression coverage.
The G02 record below describes the original milestone baseline.

## Official tool integration

`createHarnessOfficialToolProvider` accepts reviewed `OfficialToolBindingV1`
bindings and returns a Studio-only provider port. Pass the same port to the
Host tool runtime and Harness transport. Native tools must be registered in
the same root; this factory does not install Web, Browser or Node providers.

The model uses Studio discovery and wrappers. Native schemas are filtered out,
and a monotonic guard requires a one-use Host execution ticket. The public
upstream execution pipeline still runs its policies and result hooks. Host
approval, budgets, cancellation and call records remain authoritative. Nested
native calls are rejected; session shutdown aborts and drains active calls.
Only bounded JSON results are supported at this stage, pending explicit
attachment mappings. See [H3 implementation and validation](../../docs/architecture/harness-upgrade-and-extended-tools-plan.md#11-h3-实施记录2026-10-06).

`createHarnessExtendedTools` additionally installs the official Web runtime,
HTTP fetch and DeepSeek search providers, the public Playwright MCP session
runtime, and Node PTC with its filesystem/subprocess/sandbox services. Pass
`{ web: true, browser: {}, node: {} }` to select all three; omitted capabilities
are not installed. Browser workers start on the first authorized browser call,
reuse an isolated session, and drain on cancellation/disposal. Native schemas
and server instructions remain outside the model's Studio tool surface.

The application enables these capabilities only in its Harness profile, with
independent `AI_STUDIO_WEB_TOOLS`, `AI_STUDIO_BROWSER_TOOLS` and
`AI_STUDIO_NODE_TOOLS` switches (`0` disables). Deployment may set
`AI_STUDIO_SEARCH_BASE_URL`, `AI_STUDIO_SEARCH_MODEL`,
`AI_STUDIO_BROWSER_EXECUTABLE`, and `AI_STUDIO_NODE_EXECUTABLE`.
Search credentials come from the existing resolver, not subprocess environment.
Search reserves 2,048 auxiliary output tokens; unreported usage/cost stays unknown.
Web/Node provider modules and services load on the first authorized call, sharing
one readiness promise per capability and owner. Browser lifecycle metadata stays
lightweight; workers still start only on demand. Successful Web results are cached
within the same session/turn/credential scope for 60 seconds, with a 64-entry bound.
Concurrent identical reads share one request with independent caller cancellation;
the last departing caller aborts and drains it. Owner disposal drains pending reads,
and profile reactivation creates fresh readiness hooks and caches.

Browser support currently covers 11 reviewed text/interaction tools; image
attachments, screenshots, uploads and arbitrary output paths are not exposed.
Restricted Node execution currently requires macOS and a supported standalone
Node binary (upstream requires `^22.19.0 || >=24`; tested with 24.19.0).
The adapter adds OS read/network restrictions and Node permissions to the
official file sandbox; unsupported enforcement fails closed. Scripts receive
JSON through `await inputs.read({})`, run in fresh scratch directories and cannot
call nested Studio tools. The product persists bounded UTF-8 outputs in the
existing artifact store before cleaning scratch. See the
[implementation record and remaining release checks](../../docs/architecture/harness-upgrade-and-extended-tools-plan.md#12-h4h6-接入记录2026-10-06).

## G02 verification

Verified on 2026-08-19 with the pinned Cordis `4.0.1` and DeepSeek Harness
`dsh-v0.1.0-rc.7` (`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`):

- `npm test -w ./packages/studio-contracts`
- `npm test -w ./packages/studio-kernel`
- `npm test -w ./packages/harness-bridge`
- `npm run check`

The fixtures cover dependency diagnostics, deterministic config/profile
resolution, optional degradation, partial activation rollback, idempotent
dispose, cancellation and late-result rejection, 100 replace/unload cycles,
lazy Agent closure, upstream effect teardown, and public declaration isolation.

## Experimental browser and isolated alpha

Set `browser.backend: 'chrome-devtools'` on the composition-owned extended-tool options to select the pinned alternative; the app additionally requires `AI_STUDIO_EXPERIMENTAL_BROWSER=1` and `AI_STUDIO_BROWSER_BACKEND=chrome-devtools`. Each Session launches an isolated browser lazily. There is no attached-browser option. Schemas, approval tickets, cancellation and cleanup use the existing gateway.

`TMPDIR=/private/tmp node scripts/verify-harness-alpha.mjs 0.2.1-alpha.1` from the repository root builds a temporary dependency environment from already compiled bridge files and runs compatibility fixtures. It does not build or upgrade the application. See the P2 record in the upgrade plan for question and Team scope.
