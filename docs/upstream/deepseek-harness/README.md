# DeepSeek Harness upstream pin

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Release/tag: `dsh-v0.2.0-rc.2`
- Commit: `639ed015397290b3745d163aafe02ffee4aa3f84`
- License: MIT
- Runtime declaration: Node `^22.19.0 || >=24`
- Cordis: `4.0.4`

AIStudio 只在 `packages/harness-bridge` 直接依赖固定版本的 Cordis、agent、loop、LLM、session、tools、approval
及 Web、Browser、PTC 服务和 providers。精确 npm integrity、license/third-party snapshot digest 记录在 `config/upstream/pins.json`，lockfile 是实际解析
结果。升级 tag 时必须重新捕获 snapshot、重跑 compatibility fixture，并单独审查生命周期和工具语义。

`LICENSE.snapshot` 与 `THIRD_PARTY_NOTICES.md.snapshot` 由 `node scripts/capture-upstream-snapshots.mjs` 从 pin 中的固定 commit
生成，不手工编辑。

## 2026-10-06 Web / Browser / Node 接入

H4–H6 的基础能力已接入同一 Host 审批、预算、取消和调用日志链。当前 bridge 直接依赖 30 个
`@deepseek-ai/*` 包；完整闭包包含 46 个 `dsh-*` 包，均为 `0.2.0-rc.2`，Cordis 为 `4.0.4`。
Web 使用官方 `WebRuntime`、`HttpFetch`、`DeepSeekSearchProvider`；Browser 使用官方 provider 的
公共 `SessionResources`、scope、MCP client 与配置校验，改为首次获准调用时启动；Node 使用官方
`NodePtcRuntime`、LocalFs、LocalSubprocess、LocalSandbox、SandboxPolicy，并增加 macOS 读/网络限制。
未复制上游私有实现，没有另起执行器或 agent loop。

新依赖的精确版本、integrity、许可记录在 pins 的 `externalToolPackages`，由 `upstream:check`
同时核对 lockfile 与安装清单：

| 依赖 | 版本 | 许可 |
| --- | --- | --- |
| `@playwright/mcp` | `0.0.80` | Apache-2.0 |
| `playwright` / `playwright-core` | `1.63.0-alpha-2026-08-31` | Apache-2.0 |
| `@modelcontextprotocol/client` / `core` | `2.0.0` | MIT |
| `@deepseek-ai/node-addon-system` | `0.1.2` | BSD-3-Clause |
| `undici` / `ipaddr.js` | `8.11.2` / `2.5.0` | MIT |
| `node-pty` / `koffi` | `1.2.0-beta.15` / `3.1.1` | MIT |

Playwright alpha 是所固定 MCP 的精确传递依赖，不单独混装为另一版本。本轮安装使用
`--ignore-scripts`；未下载浏览器、安装全局工具或启用 npm 脚本能力。保留包内原始许可，
上游 license/third-party 快照仍来自固定 tag，没有为本地集成手工改写。

普通 Node 与 Electron Node 模式下，真实 Chrome/Node 进程验证均通过。公开抓取被当前机器将
`example.com` 解析到 `198.18.0.168` 的 DNS 环境阻断，官方地址校验返回 `WEB_BLOCKED_URL`；
未放宽校验。付费搜索线上凭证、正式打包路径、浏览器图像附件和非 macOS 脚本沙箱未验收。
本轮记录和配置见 [H4–H6 实施记录](../../architecture/harness-upgrade-and-extended-tools-plan.md#12-h4h6-接入记录2026-10-06)。

## 2026-10-06 Messages / Session V4 update

H1/H2 将全部 27 个已解析 `dsh-*` 包锁定为 `0.2.0-rc.2`，Cordis 锁定为 `4.0.4`。
直接依赖 integrity、完整闭包 overrides、lockfile、tag commit、许可快照及检查脚本同步更新。
旧 code-runtime/settings/credentials 不再属于当前必需闭包；新增 ptc-runtime/sandbox-policy 的依赖
并不代表启用了 Node、Web 或浏览器工具。MIT LICENSE 未变化，第三方声明重新从固定 commit 捕获。

### 请求与初始化

- 官方适配器改用 Messages API：`https://api.deepseek.com/anthropic/v1/messages`，认证通过
  `resolveAuth` 接入现有凭证端口。已知官方旧 base URL 归一化到 Messages；自定义
  `/chat/completions` endpoint 返回迁移错误，其他自定义 base URL 必须自行支持 Messages。
- 默认模型改为 `deepseek-flash`，固定目录只提供 `deepseek-flash` / `deepseek-v4-pro`。
  已保存的退役模型 id 明确拒绝，由用户重新选择，避免静默改写显式选择；本轮仍发送文本内容。
- 适配 `tool_use` / `tool_result`、分片参数及 usage 流；Session 内工具结果使用独立的 `role: tool`。
- 等待 setup 和异步 `agent/created` 完成后才发布 handle、发首请求。初始化中的取消、关闭与
  根实例销毁均传播 abort；失败释放 scope，同 id 可以重建。预取消请求不会创建会话。

### 上下文与恢复

- 新建 Harness Session 使用格式 V4。Studio 未挂载 Harness Persistence，不存在待迁移的
  Harness V3 磁盘日志；Studio 自身 durable journal / checkpoint 格式保持不变。
  重启丢失 provider handle 后，用原日志绑定新的 V4 Session，并标记需要 checkpoint replay，
  不重放已执行工具或未确认外部动作。
- 移除 bridge 对 `snapshotEvents()` / `eventAt()` 同步历史接口的调用。该版本没有可直接替换的
  Session 异步历史方法；使用公共 `session/event` 增量维护当前 turn 和活动 Surface。
  日常工具派发不扫描完整历史，压缩只保留活动 Surface 的恢复数据。
- 继续由 Studio W3 管理压缩，没有开启第二个 Harness 自动压缩器。保护 system/developer 消息、
  工具调用与结果配对；压缩准备失败、请求取消、provider 失败或 durable confirm 失败时恢复原 Surface。
  回滚以追加事实完成，保留 replay 元数据，不重复记录旧 assistant usage。
- Messages 的 input 为未缓存输入；归一后的总输入仍是 input + cache read + cache write。
  未报告的 reasoning 分项保持未知；价格目录声明 reasoning 已包含在总输出时，使用总输出估算费用，
  避免已知账单量仍占用子任务预算。单独计费且缺 reasoning 时，费用仍未知。未修改历史价格与账单。

### 验证

本次使用真实固定版本 AgentLoop、Adapter 与 Session，HTTP 为进程内 Messages SSE fixture；
不是线上 DeepSeek 验收。Bridge 40/40、backend 22/22、Runtime 114/114、Host 定向集成 17/17 通过。
覆盖流式文本/工具参数、会话隔离、usage、重试、取消、异步初始化清理、V4 重建、压缩与回滚、
并行只读、批处理和子任务预算结算。应用构建、upstream pins 与导入边界通过。

仓库验证补充（Node 24.19.0、macOS x64、`TMPDIR=/private/tmp`）：

- `m14:capability:capture` 的前 13 组共 157 项通过，包括行为面板、产品和 expandable 窗口。
  第 14 组 task-checkpoint-continuation 为 24/25，通过条件未满足，因此没有写入新证据。
  失败为 `g11-task-product.test.mjs` 的 early-completion 用例在约 2 秒等待内超时；该用例使用
  模拟 Runtime。整组独立复跑 25/25 通过，超时未复现；没有修改等待阈值或伪造通过报告。
- `npm run check` 的 contracts、类型、边界、pins、候选包、协议 spike 和 59 项 quick evaluation
  通过，随后在 `m14:capability:check` 因 `stale verification input binding` 退出。
  该报告在升级前已过期；本轮重采集未全部成功，继续保留原报告，因此后续总检查阶段未执行。
- 全量门禁未通过，线上 DeepSeek、后续外部工具插件及正式性能验收均未验证；不推进 milestone。

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

## P2 experiments and alpha isolation (2026-10-06)

Production remains RC. Chrome DevTools uses the official provider `0.2.0-rc.2` and `chrome-devtools-mcp@1.9.0` (Apache-2.0), with exact lock/integrity pins. Its browser process is lazy and session-owned; raw tools remain behind Studio approval and execution tickets. The reviewed catalog excludes file export, upload and arbitrary JavaScript evaluation. Playwright remains the default.

The isolated alpha probe passed 56 bridge tests with `0.2.1-alpha.1` / Cordis `4.0.5-alpha.1`. Production lockfile was unchanged. This is not production or online-provider acceptance. See [P2 implementation and limits](../../architecture/harness-upgrade-and-extended-tools-plan.md#14-p2-实验入口与-alpha-隔离验证2026-10-06) and `config/upstream/harness-alpha-candidate.json`.
