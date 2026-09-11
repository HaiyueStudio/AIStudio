# DeepSeek Harness upstream pin

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Release/tag: `dsh-v0.1.5-rc.2`
- Commit: `fb2c4b9e698e30edb738bca4cf0618587db7d203`
- License: MIT
- Runtime declaration: Node `^22.19.0 || >=24`
- Cordis: `4.0.2`

AIStudio 只在 `packages/harness-bridge` 直接依赖固定版本的 Cordis、agent、loop、LLM、session、tools 与 approval
packages。精确 npm integrity、license/third-party snapshot digest 记录在 `config/upstream/pins.json`，lockfile 是实际解析
结果。升级 tag 时必须重新捕获 snapshot、重跑 compatibility fixture，并单独审查生命周期和工具语义。

`LICENSE.snapshot` 与 `THIRD_PARTY_NOTICES.md.snapshot` 由 `node scripts/capture-upstream-snapshots.mjs` 从 pin 中的固定 commit
生成，不手工编辑。

## 2026-09-11 compatibility update

Upgraded from `dsh-v0.1.0-rc.7` to `dsh-v0.1.5-rc.2`. All 28 resolved `dsh-*` packages are pinned
to the same release through root overrides. Cordis is pinned to `4.0.2`; nested or mixed Harness
runtimes are rejected by `upstream:check`. Direct package versions, integrity values, installed
licenses, the expanded compatibility list and both license snapshots are checked together.
The upstream MIT license is unchanged. The third-party notice was recaptured from the fixed commit;
it covers the full upstream repository, including optional Web/CLI packages not mounted by Studio.

- Mount `SessionProjectionRegistry` before AgentLoop in the existing Studio-owned scope.
- Provide the direct DeepSeek adapter's mandatory `prepareExtensions` hook with empty fields and
  a no-op acceptance callback. Studio does not mount optional session-upload or plugin-metadata services.
- Read text from `agent/assistant-stream`, correlating attempt ids and increasing frame revisions
  to the turn announced by each stream start. Keep usage and terminal facts on `session/event`;
  do not replay embedded assistant streams as duplicate text.
- Replace the removed `Session.events` property with the public `snapshotEvents()` API for tool
  turn attribution. Cancellation, late results and all new listeners remain scope-owned.
- Use the pinned catalog's 1,000,000-token combined context capacity only for the official endpoint;
  Studio's pressure calculator subtracts its output/safety reserves. Custom endpoints remain unknown.
  Output caps follow the upstream default of 256,000. Native compaction and PTC remain unmounted.
- Preserve the explicit Studio default (`deepseek-v4-flash`, or the configured model) as the first
  catalog entry. New upstream entries cannot silently change the default. The upstream catalog also
  exposes `deepseek-flash` and `deepseek-v4-flash-vision-exp`; Studio still sends text-only requests.
- Studio's own durable session/checkpoint remains the recovery authority. No Harness persistence
  service is mounted, so no project or Studio journal is migrated to Harness session format V3.

### Pricing

The [official V4.1 announcement](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) and its
[pricing table](https://www.deepseek.com/images/blog/deepseek-v4-1-flash/pricing-en.jpg) were reviewed
on 2026-09-11. From 2026-09-10 04:00 UTC, the two older Flash ids route to V4.1 Flash. Catalog 1.1.0
uses the published peak rates for `deepseek-flash` and those aliases: USD 0.30 uncached input,
0.006 cached input and 1.20 output per million tokens. Off-peak rates are half those values.
These are conservative estimates, not actual invoices. Studio does not infer per-request tariff
windows from one turn timestamp, or rewrite historical cost records. Existing non-Flash entries
are unchanged; the announced September 14 Pro routing change is not applied early.

### Regression coverage

`packages/harness-bridge/test/harness-upgrade.test.mjs` runs the actual pinned AgentLoop/adapter with
an in-process SSE fixture (no provider requests). It covers interleaved sessions, repeated turns,
tool-call continuation fragments, result round trips, nonduplicated text/usage, cancellation and
resumption, pending-tool disposal, bounded request retries, and explicit model/capacity selection.
The existing lifecycle suite and public declaration boundary checks remain part of the bridge tests.
Pricing tests check the new model and aliases against the same versioned JSON catalog.

The capability capture and Agent tool suites run test files serially because their fixtures launch
compiler workers under bounded deadlines. The 80ms timeout fixture applies its ceiling after project
setup, so it tests the intended operation. Behavior discovery waits use the test's abort signal and
one 60-second whole-flow deadline, covering repeated analysis and journal writes without a separate
7.5-second phase deadline. Evidence path validation now rejects Windows absolute
paths on every host. On macOS these checks use `TMPDIR=/private/tmp`: the default `/var` alias is a
symbolic link and is correctly rejected by project-history path validation.
The product smoke uses Command+Z on macOS and Ctrl+Z elsewhere, matching CodeMirror's undo binding.

### Validation on 2026-09-11

Host: Node 24.19.0, macOS x64; window/integration runs used `TMPDIR=/private/tmp`.

- Bridge: 21/21; backend adapters: 21/21; Agent Runtime: 83/83.
- Application build, dependency tree, upstream pins and import boundaries passed.
- `m14:capability:capture`: 12 suites, 123 cases passed with no skips; generated records bind the
  current source/lock inputs. Both behavior window tests passed.
- `npm run check`: contracts, types, boundaries, pins, candidates, quick evaluation, capability
  verification, behavior (33), workspace (5), Agent tools (107) and logic (23) passed. The final
  integration stage executed all 46 files: 214 cases passed, 1 failed, none skipped.
- The single failure is `apps/ai-studio/test/m14-integration/product-main.mjs` in `large()`: its
  frozen performance budget requires Windows 10 / i7-7700 / 8 logical CPUs and rejects this
  macOS / i7-9750H / 12 logical CPU host before measurement. The budget and machine assertion
  were not changed; this run is not a full green `npm run check` or a performance acceptance.
  Generated integration output was preserved outside the repository, and the tracked historical
  output was restored. No milestone acceptance was advanced.
- No real online provider call was made. Online Harness acceptance remains separate.
