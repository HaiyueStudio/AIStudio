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
