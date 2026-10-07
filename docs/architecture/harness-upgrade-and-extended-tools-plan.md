# Harness 升级与外部工具接入规划

日期：2026-10-06。代码基线：`c4fa2477d58ad89f7b1e5223e3f00f7b65918c38`。

状态：H1–H7 已实现并通过本地定向回归，生产依赖为 `0.2.0-rc.2` / Cordis `4.0.4`。Web、Playwright、Node 已接入；P2 异步问答和 Chrome DevTools 为默认关闭的实验能力，Team 仅有准入检查入口。alpha 单独验证通过，不切换生产依赖。H8 真实任务验收仍待完成，不推进现有 milestone。见第 12–14 节。

## 1. 决策与版本范围

先以 `dsh-v0.2.0-rc.2` 为兼容升级目标，再接入官方 Web、Playwright MCP 和 Node PTC 实现。该版本仍是预发布版本，必须通过项目自己的验收；选择它是为了把基础迁移与后续 alpha 变更分开，不是认定 RC 已稳定。

本次查到的最新发布为 2026-10-03 的 `dsh-v0.2.1-alpha.1`，主要额外涉及插件元数据、诊断入口等调整。它移除了 runtime invariant 插件及 `./invariant` 导出，当前根依赖 overrides 仍包含旧诊断包，因此列入后续单独升级。用户要求的三类能力在 `0.2.0-rc.2` 已有发布，无须为了它们先引入 alpha。[发布记录：RC](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)、[alpha](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1)。

| 项目 | 规划时基线 | 本轮规划目标 |
| --- | --- | --- |
| Harness | `0.1.5-rc.2` | 所有选用的 `dsh-*` 及其依赖闭包统一到 `0.2.0-rc.2` |
| Cordis | `4.0.2` | 以 `4.0.4` 为候选精确锁定值，满足新包 `~4.0.4` peer 要求，H1 验证完整闭包 |
| 发布来源 | `pins.json` 的旧 tag、commit、integrity | 更新 tag、完整 commit、每个包 integrity、许可证快照和 lockfile |
| 工具执行 | Studio 工具由 Host 执行 | 官方实现经 bridge 接入同一 Host 工具执行、审批、预算与记录体系 |

**现在不能直接把新版插件装进旧 runtime。** npm 发布元数据明确要求新版 `dsh-agent` / `dsh-tools` 等 peers，且 Cordis 最低 patch 已变化。也不能靠 `--force`、`--legacy-peer-deps` 或第二套 Cordis 绕开：它们会破坏现有单根生命周期与服务身份。接入前置工作是 H1–H3。

## 2. 优先级与本地影响

| 优先级 | 调整项 | 当前代码依据 / 影响 | 完成条件 |
| --- | --- | --- | --- |
| P0 | 依赖、pins 与检查脚本 | `config/upstream/pins.json`、`compatibility.json`、根 `package.json`、bridge manifest、lockfile；`scripts/verify-upstream-pins.mjs` 硬编码旧 commit / Cordis | 单一兼容闭包、完整来源校验；不降低现有边界检查 |
| P0 | 模型协议与模型选择 | `packages/harness-bridge/src/harness-agent.ts` 适配器配置及默认 `deepseek-v4-flash`；`packages/agent-backends/src/harness-backend.ts` 固定协议版本 | Messages 请求、流式工具调用、usage、取消均通过；旧 endpoint / 模型选择给出明确迁移结果 |
| P0 | Session 与上下文迁移 | `packages/harness-bridge/src/request-context.ts` 依赖同步 `snapshotEvents()` / `eventAt()` / Session 克隆，负责压缩回滚 | 使用新公共历史 API；旧会话可恢复，压缩失败可回滚，工具调用与结果完整配对 |
| P0 | 初始化、取消和恢复 | `harness-agent.ts` 的 session setup、pending results、重试；新浏览器在 `agent/created` 等待连接 | 首请求等待必要初始化，停止后不产生晚到副作用，未确认的外部动作不自动重放 |
| P0 | 外部工具执行适配 | `packages/game-authoring-tools/src/runtime.ts` / `plugin.ts` 当前主要围绕静态游戏工具；原生插件工具不经过现有 `tool-request` 转发 | 新工具进入同一发现、prepare、审批、execute、cancel、结果记录流程，无旁路或重复执行 |
| P1 | 搜索与抓取 | 新官方 provider + Studio 工具适配；接入凭证与辅助请求预算 | 引用来源、超时取消、结果限额、缓存、额外费用可见 |
| P1 | 浏览器操作 | 官方实验性 Playwright MCP，按 session 管理 | 可导航、交互、读取页面、截图；Electron 中初始化、取消及清理验证通过 |
| P1 | Node 脚本执行 | 官方 Node PTC + fs/subprocess/sandbox 服务 | 脚本可计算和生成产物，作用域可控，进程可回收，结果可追溯 |
| P1 | 工具与上下文效率 | 现有 W1–W8 的 discovery、W3 压缩、W6 调度和 W7 子任务资格 | 新能力不造成全量 schema 注入、轮询等待或嵌套并发失控；有对照数据 |
| P2 | 异步问答（实验入口已实现） | Studio Host 工具和现有问答卡片；官方 timed question 尚未直连 | 等待期间只读工作可继续；未回答不视为授权，见第 14 节 |
| P2 | alpha、其他浏览器 provider、Team / workflow | Chrome DevTools 实验入口和 alpha 隔离验证完成；Team 仅有准入检查 | Stagehand、官方 Team 执行和 alpha 生产迁移仍待后续，见第 14 节 |

上游的 Messages、Session V4、异步初始化、PTC 与历史读取变化见 [0.1.7-rc.1 迁移说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1)。本地需要迁移的是实际使用到的接口；上游桌面 UI、完整 Profile 和插件商店不整体移植。

迁移还需覆盖四个具体细节：bridge / backend / 测试中的固定版本标识统一更新；现有 Studio 压缩仍由 W3 管理，不能同时启用第二个原生自动压缩器；如启用上游 spill policy，按新 `maxInlineTokens` 重新设定预算，不能沿用 `maxInlineBytes` 的数值；当前工具结果主要渲染为 JSON 文本，浏览器图片必须新增正式附件映射与保留策略，不能仅将截图对象序列化后宣称模型已看见图片。

## 3. 已确认可复用的官方插件

以下八个包的 `0.2.0-rc.2` 均已通过 npm registry 精确版本查询确认存在；不是仅根据 master README 推断。npm 查询只读，本轮没有安装到项目。

| 能力 | 官方包（前缀均为 `@deepseek-ai/`） | 接入决策 |
| --- | --- | --- |
| Web 服务 | `dsh-web` | 复用 `ctx.web.search/fetch`，bridge 输出 Studio 类型 |
| DeepSeek 搜索 | `dsh-web-search-deepseek` | 首选已有 DeepSeek 凭证；独立配置搜索 endpoint / model |
| HTTP 网页抓取 | `dsh-web-fetch-http` | 复用官方网络校验、大小与时间限制 |
| Web 原生工具 | `dsh-tool-web` | 官方已有 `web_search` / `web_fetch`；首期复用 provider 服务，避免再注册一组绕过 Host 的同名入口 |
| 浏览器能力声明 | `dsh-browser-use` | 与一个浏览器 provider 同时挂载 |
| Playwright MCP | `dsh-experimental-browser-use-playwright-mcp` | 首选 provider；该 tag 的源 manifest 固定 `@playwright/mcp` 为 `0.0.80`，最终以发布闭包复核 |
| PTC 服务 | `dsh-ptc-runtime` | 复用 `resolve(request)` → `run(spec)` |
| Node 执行 | `dsh-ptc-runtime-node` | 复用独立进程、限制与清理实现，不另写 eval/VM 执行器 |

Web 还提供 Exa / Perplexity provider，可在后续有相应凭证时切换。浏览器另有 Chrome DevTools MCP / Stagehand；首期选 Playwright，避免同时增加操作面和额外 AI 推理链。官方浏览器公共服务只登记 provider 身份，没有统一的浏览器操作方法，不能假设存在 `ctx.browser.navigate()`。[Web 文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/subsystems/web.md)、[浏览器文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/subsystems/browser-use.md)。

## 4. 接入架构

沿用一条执行链：

```text
用户意图 / 约束 DSL
  → 能力选择与 tool.search
  → Studio Host：参数校验、授权范围、预算、资源锁、调用记录
  → harness-bridge：上游类型隔离、官方插件调用
  → 官方 Web / Browser / Node provider
  → 有界结果、来源与产物引用
  → Host 归档并继续任务
```

所有 `@deepseek-ai/*` 导入仍限定在 `harness-bridge`。应用组合层负责启用配置；renderer 不创建进程、不持有凭证。扩展现有工具目录与 Host 派发端口，不为外部工具另建一个 agent loop、持久任务系统或审批系统。共享 Task/Usage/Cost/Observation 定义继续由 `studio-contracts/src/m12.ts` 及 contract index 管理。

H3 将审定的原生工具映射为 `official.*`，加入现有 Studio 工具目录。模型只看到选定的 Studio 包装工具，经发现或 `studio.tool.invoke` 进入 Host；原生插件 schema 在公共 `system-prompt/assemble` 阶段过滤。Host 校验参数、预算及审批后，bridge 才签发绑定实际 Agent、调用和参数摘要的一次性进程内票据，通过公共 `ctx.tools.execute` 运行完整官方执行链。单调 `tools.guard` 拒绝无票据的原生调用，执行令牌防止重复派发，`tools/execute` 及整条执行链的异步作用域阻止嵌套调用反向等待 Host。原生 pre/guard/around/post/result 阶段仍生效，最终结果回到原 Host 记录链。

Web 与 Node 也可以通过官方 service 提供符合统一端口的实现；需要原生插件工具时使用上述映射。H3 暂时拒绝全部原生嵌套工具调用，H6 如需脚本绑定函数，须另做共享预算、授权和资源锁的适配；不能直接放行以绕过 Host。公共接口不能满足单次执行与完整取消时，该 provider 不上线，先解决 bridge 适配缺口。

浏览器描述、JSON Schema、资源和 server instructions 均经过验证与会话隔离。模型发现到一个工具不等于获得该工具的权限。Unknown effects 默认阻止自动并行；外部动作不放入 Document 原子事务，也不声称能由撤销恢复。

当前用户请求已将网络与受控脚本纳入范围；旧 M06 的工具范围限制不作为额外询问理由。实施时更新当前能力契约和边界测试，但保留 M06 历史验收含义。Codex 后端的内置 shell/network 禁用策略不因此整体放开；需要时让两个后端调用同一 Studio 外部工具入口。

## 5. 三类工具的产品行为

### 5.1 搜索与抓取

拟提供 `official.web.search` 和 `official.web.fetch`，沿用 Studio versioned schema、preview、effect/risk、取消与结果引用。H3 已保留 `official.*` 命名空间，具体工具定义由 H4 注册。

- 默认只有任务涉及外部资料时才选择 Web 能力；引擎与项目事实优先查已有文档 / 结构化工具。
- 多个独立查询合并为一次模型工具请求，在剩余预算允许时有界并发；不会把批量包装误算成一次免费搜索。
- 已知可信 URL 优先抓取，避免重复搜索。相同请求在任务内去重；按 provider、endpoint、model、凭证作用域、参数隔离缓存，明确 TTL 与获取时间。
- 每条结果保留 URL、可用的标题/日期和截断标记。只把相关摘要注入上下文，全文按需读取；网页内容作为外部证据，不成为系统指令。
- 接入现有凭证解析端口，不把 key 写进插件配置或子进程环境。搜索 endpoint 与对话 endpoint 独立，模型无权自行改变目的地。
- 首期建议每批最多 2 个查询、每查询最多 5 条来源、搜索 30 秒 / 抓取 15 秒软目标及明确硬超时；这些是 Studio 初始配置提案，需用真实调用调整，并非上游默认值。
- 公网抓取使用官方 public-address 校验；本地游戏预览走明确授权的 preview/browser 通道，不为 localhost 需求全局放开 Web 抓取策略。

**费用注意：** DeepSeek 搜索通过独立 Messages 调用执行，每查询产生额外模型耗时与 token，`maxResults` 只是返回来源限额，不保证同比减少搜索请求成本。对辅助请求单独预留预算，能获取 usage 时记录实际量；插件未暴露准确量时标为未知/估算，不能记成零。搜索默认模型也要独立验证，不能盲目继承插件中的旧默认值。[搜索插件说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/web/web-search-deepseek/README.md)。

### 5.2 浏览器

首期范围是浏览器页面与游戏预览验证：导航、页面快照、定位交互、console 信息、截图。Canvas 游戏仍优先用现有 playtest / observation 工具获得确定性状态；浏览器补足真实网页与渲染行为验证。

- 使用官方 Playwright provider 的 launch 模式，按 live Session 隔离浏览器；会话内跨轮复用，结束后清理。默认不接管用户已登录的个人浏览器。
- 根据任务路由在创建 agent 前选择浏览器配置；普通编辑任务不启动浏览器。中途确需浏览器时进行显式、有记录的 session rebind，并保留 Host 任务与预算，不假设热挂载会自动接管已有 session。
- 同一浏览器 session 的操作串行；导航、点击后的观察有依赖，不对同一页面盲目并发。独立 Web 搜索可以与浏览器操作重叠。
- DOM / accessibility 快照优先，截图按需；截图须接入附件存储和实际支持图像的模型路由，不将 base64 反复拼进文本。
- 工具按任务筛选，首次只呈现必要描述；MCP 的全部工具、资源说明和页面正文不常驻系统提示。
- 复用现有授权，不为已授权只读操作重复询问。对外提交等动作仍按实际效果分类；取消后若动作可能已送达，先重新观察再决定是否重试。
- 真实 Electron 验证包括 Chromium 可发现性、MCP worker 启动、打包路径、启动失败清理、跨会话隔离、断连恢复；provider 不可用不得拖垮普通编辑任务。

官方 provider 在 agent 创建时连接，加载后不接管已存在的 live Session；浏览器状态也不从日志恢复。因此按需启动需要上述路由 / rebind，而不是简单加一个 lazy import。[Playwright provider 说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/experimental/browser-use-playwright-mcp/README.md)。

### 5.3 Node.js 脚本补充能力

拟提供一个 `official.code.run` 工具，用官方 `dsh-ptc-runtime-node` 执行模型生成的 JS / 可擦除类型的 TypeScript。适用场景包括数据转换、批量计算、程序化生成文件，以及现有工具无法表达的有限组合操作。首期不全局切成 `tools.mode: both`，避免同时把全部工具 schema 与 PTC SDK 发给模型。

- 每次 fresh process；输入带任务说明、代码、输入产物引用和期望输出。Host 固定工作目录、权限、deadline、输出限额；执行和批准的是同一份代码摘要。
- 读范围限已授权输入与运行依赖，写范围限任务 scratch / output 目录。网络与子进程能力由实际 sandbox 后端约束，不能只靠代码声明、过滤 import 或清空 `process.env`；所需限制无法实施时返回不可用。
- 首期建议执行默认 30 秒、上限 120 秒、日志/JSON 结果 256 KiB、V8 old generation 256 MiB；附件另走产物限额。它们是待验证的 Studio 配置，不是进程树总内存或 CPU 保证。
- 绑定函数只暴露本任务允许的 Studio 能力；嵌套调用共享父任务预算、授权与资源锁，拒绝递归 `code.run`。程序的 `Promise.all` 不能扩大 Host 并发额度。
- 产物经扫描、类型/大小检查后注册为引用；修改项目 Document 仍通过原工具与 History。脚本不得直接改项目存储来绕过撤销或 exact revision。
- 不自动安装 npm 包。内置模块与审定依赖满足不了时返回具体缺口；重试必须先确认上次执行是否留下产物/外部效果。
- 复用插件 `nodeExecutable` / `bootstrapPath` 配置，验证开发态与打包 Electron 态。上游已处理 `ELECTRON_RUN_AS_NODE` 的启动选择，但仍需项目打包实测，不能只依赖 CLI 的成功。
- UI 复用调用卡片展示代码、输出和产物；只在超出现有授权时走原审批流程，不为脚本的每个已授权子调用重复弹窗。

Node 插件需要同时提供 fs、subprocess、sandbox、sandboxPolicy 等服务。它已有进程执行与清理实现，但“独立进程”本身不等同于完整沙箱。[Node provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/ptc-runtime/ptc-runtime-node/README.md)、[PTC service](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/ptc-runtime/ptc-runtime/README.md)。

## 6. 与现有效率优化的衔接

保留已实现的 W1–W8 和意图约束来源追踪。新增 capability、资源和预算字段通过现有 schema 演进，不再创造一套平行的意图 DSL。

| 方面 | 调整方案 | 避免的额外开销 |
| --- | --- | --- |
| 工具选择 | 内置专用工具优先；外部资料用 Web；真实页面用 Browser；复杂计算或工具缺口用 Node | 简单改属性也先开浏览器、生成脚本 |
| 目录加载 | 复用 `tool.search` / `studio.tool.invoke` 与固定 manifest；按 capability 显示必要工具 | 每轮带上完整 MCP 工具目录 |
| 前缀缓存 | 在目标模型确实支持时评估上游增量工具定义；否则保持现有稳定工具集合及 rebind | 无验证地改 prompt 顺序破坏 KV cache |
| 结果压缩 | 统一文本/图像预算、摘要及引用；保留错误、调用配对、约束来源与未完成事项 | 网页、截图、脚本日志跨轮重复堆积 |
| 去重 | 同任务同输入合并进行中的只读调用，缓存有时效和作用域 | 多代理重复查同一事实；缓存越权复用 |
| 等待 | 事件通知完成与取消，展示准备/执行/清理状态；耗时拆分为模型、工具、审批、初始化 | 定时轮询及把初始化误判为模型停顿 |
| 并行 | 继续用 W6 依赖和资源锁；共享页面串行，独立读取可并行 | Harness、Host、脚本各自开池形成并发乘积 |
| 任务拆解 | 沿用 W7 资格门槛与总预算；只有独立输入/产出且预期收益超过协调成本才拆 | 多一次子代理调用却没有减少关键路径 |

新版本没有自动证明上述优化有效。动态工具与异步问答需分别做真实模型能力探测；不根据版本号直接开启。用户回答可以迟到，但依赖该回答的动作仍须等待；审批超时不能成为同意。

## 7. 可独立验收的实施阶段

规模为相对工作量：S 小、M 中、L 大，不作为工期承诺。每阶段完成后更新本表证据，失败保持未完成。

| 阶段 | 优先级 / 规模 | 具体交付 | 依赖与关键验收 |
| --- | --- | --- | --- |
| H1 依赖闭包与迁移清单（已实现） | P0 / M | 精确版本、tag commit、integrity、许可、overrides、pins 检查；记录 API 编译差异 | 起点；禁止混装、复制上游私有源码或移除边界断言来通过检查 |
| H2 Bridge 与 Session 升级（已实现） | P0 / L | Messages、新初始化、增量 Surface 投影、V4 恢复、usage 归一、压缩回滚；移除实际失效旧配置 | H1；真实 session 创建/恢复/取消，工具配对及历史一致；旧 endpoint 不静默误路由 |
| H3 官方工具接入端口（已实现） | P0 / L | Studio 工具目录扩展、Host 执行适配、原生工具映射、可选配置与统一记录；具体浏览器工具及资源在 H5 注册 | H2；本地真实 Harness 执行链验证允许只执行一次、拒绝/预算拦截不执行、取消排空，嵌套调用和无票据调用拒绝；见第 11 节 |
| H4 Web 搜索/抓取（基础接入已实现） | P1 / M | 官方 Web providers、凭证桥、批量/去重/缓存、引用、辅助费用 | H3；真实查找与抓取、缺凭证/429/超时/重定向/取消；搜索 usage 未知不填零 |
| H5 浏览器（文本交互已实现） | P1 / L | 官方 Playwright provider、按需 session、图片结果、预览验证 | H3；本地受控预览与公共页面验收；Electron worker、跨 session 隔离、重复启停无泄漏 |
| H6 Node 补充工具（macOS 受限执行已实现） | P1 / L | 官方 PTC Node 及依赖服务、scratch/产物、代码预览、限额、嵌套调用 | H3；计算/生成文件成功；越界/死循环/输出爆量/取消/残留进程及打包态验收 |
| H7 上下文与调度优化（已实现本地优化） | P1 / M | 分层目录、预算化结果、并发准入、完成事件、性能观测 | H4–H6；本地回归通过，生产性能对照仍待 H8，见第 13 节 |
| H8 发布验收与回退 | P0 发布门槛 / M | 真实任务对照、恢复/回滚演练、各能力开关、完整检查与限制记录 | 前述待发布能力；未通过的能力保持不可用，不能以 mock 成功替代上线证据 |

实施依赖：`H1 → H2 → H3 → H4/H5/H6 → H7 → H8`。H3 契约稳定后，Web、浏览器、Node 的开发与验证可以并行；修改共享 bridge / contracts 的集成需要协调。同一任务中的工具并行仍由运行时依赖与资源锁决定，两者不能混为一谈。

推荐第一批交付 H1–H4，先使框架升级和网络资料获取可用；第二批 H5–H6；随后完成 H7 和全量 H8。每批仍执行其对应发布验收，不等全部能力完成才发现基础会话回归。

## 8. 验证、度量与回退

先保存当前基线结果，区分既有失败与升级新增失败。针对改动运行 bridge、backends、orchestration、runtime 与 tools 的相关测试，再跑 `npm run upstream:check`、`npm run boundaries:check` 和 `npm run check`。Electron 与真实 provider 测试使用独立任务目录，不污染历史验收产物；没有凭证或运行环境时明确列出未验证项。

固定六组场景比较升级前后：简单属性编辑、多对象批处理、长上下文恢复、带引用的网络研究、浏览器预览诊断、程序化生成并导入资源。旧版不支持的新能力只比较“当前人工/多工具流程”与接入后的流程，不伪造旧版成功样本。

记录任务成功率、无效/重复调用数、模型往返、输入/输出/缓存 token、搜索辅助 token、费用、总耗时 p50/p95，以及初始化、审批、排队、执行、清理时间。缓存 token 口径以新 adapter 实际定义为准，专门检查现有 `inputTokens + cacheReadTokens + cacheWriteTokens` 是否产生重复计数。

正确性为硬门槛：任务质量不退化；审批和预算无旁路；取消后不继续写入；约束与来源不丢失；Document 修改可由原 History 撤销；外部结果未知不自动重放。效率目标先定为“原有简单任务不增加模型往返，新能力任务减少可避免的调用”，百分比改善在有基线后设定，不预先承诺。

H2 已确认 Studio 未挂载 Harness Persistence，因此当前没有 Harness 磁盘日志需要迁移；已有 Studio journal 继续作为恢复依据，不重写 Document History。回退时还原整套依赖与 bridge 适配，再从 Studio checkpoint 重建 live Session。如果后续启用 Harness 持久化，首次打开旧日志前必须备份并迁移副本，新 V4 日志不能交给旧 runtime。Web/Browser/Node 各自有功能开关，但禁用不会删除已产生的结果或假装撤销外部动作。

## 9. 规划阶段结论（历史记录）

三类能力均有官方实现，不需要自研搜索引擎、浏览器驱动或 Node 执行器。需要自建的是薄的 Studio 集成：授权和预算、工具发现、调用关联、结果与附件、会话生命周期。现有版本与新插件不兼容，先完成 H1–H3 才能真正启用；本轮先交付该更新规划，尚未改变依赖或注册新工具。

本轮检查：规划结构与 `git diff --check` 通过；`upstream:check`、`boundaries:check` 通过。`npm run check` 执行到 `m14:capability:check` 时因 `stale verification input binding` 退出，此前的类型、边界与 59 项 quick evaluation 已通过。能力报告与输入摘要不一致需在 H1 基线整理中处理，本轮未重写历史验证报告；全量检查不能记为通过。

## 10. H1/H2 实施记录（2026-10-06）

已锁定 27 个 dsh 包和 Cordis 的单一闭包，完成 Messages、Session V4、新模型目录、异步初始化取消、压缩回滚与 Studio 日志重建。新 API 没有直接替换旧同步历史方法的 Session 异步函数，实际采用公共事件维护活动 Surface，避免每次工具派发扫描或复制完整历史。reasoning 分项未知但已计入总输出时可以估价，修复由此导致的 W7 预算无法释放。

Bridge 40、backend 22、Runtime 114、Host 定向集成 17 项通过；真实 provider 尚未验证。`npm run check` 在能力报告摘要过期处退出；重采集的任务续接组出现一次超时，整组独立复跑 25/25 通过，但未重写证据或宣称全量门禁通过。完整检查结果以 [升级记录](../upstream/deepseek-harness/README.md) 为准。当时 H3 工具端口及 Web/Browser/Node providers 尚未接入。

## 11. H3 实施记录（2026-10-06）

已新增 `OfficialToolBindingV1` / `OfficialToolProviderV1` 和 `createHarnessOfficialToolProvider`，应用 profile 可选注入同一个端口给 Host 工具运行时与 Harness transport。上游 Context、Agent 和工具类型保留在 bridge 内；没有新增注册中心、审批系统或 agent loop。未配置端口时维持原有工具集合。

- 审定绑定包含版本、命名空间、输入/输出 schema、effect/risk、审批要求、超时和结果限额，验证后冻结；每次执行复核原生 registry schema，避免插件重连静默改变获批参数含义。
- 工具复用 `tool.search`、prepare、exact revision / 参数摘要审批、execute、Host 调用数预算、超时、取消和日志链。外部副作用必须单次审批，不能使用 allow-always，按保守独占资源锁调度；不进入 Document 原子事务，不增加 Document 修改计数，也不声明可撤销。
- 单次票据、执行令牌和异步作用域同时防止原生直调、重复执行及前后置回调中的嵌套绕路。会话取消、关闭和 root dispose 会中止并等待执行排空，取消后的晚到结果不会作为成功交付。
- 输入校验并拒绝凭证字段；输出限制为有界 JSON 对象，经过 schema 校验、脱敏和再次校验。原始 provider 错误不直接传给模型。非文本内容、附加上下文和结束轮次控制当前拒绝，图片/附件由 H5 单独映射。
- 同时修复现有运行时的重复并发领取 preparation、排队期间取消仍启动、日志失败未释放资源锁及 dispose 未等待执行排空的问题。

本轮验证使用真实锁定版本的 Harness ToolRuntime / AgentLoop 和 fixture 原生工具，覆盖发现、审批允许/拒绝、预算耗尽、取消、超时、关闭、schema 漂移、重复派发、前后置策略、嵌套调用、错误脱敏和日志唯一性。它验证统一接入链，不代表已上线 Web/Browser/Node 插件。H4 还须补充辅助搜索请求的 usage/费用预算；H3 保留的是现有 Host 调用数、时间和结果预算。

验证结果：

- 官方工具定向测试：25/25（bridge 7、工具运行时 13、真实 Host 集成 5）。
- 工具运行时全量回归：200/200；contracts + bridge 全量回归：54/54；Shell 会话回归：23/23；应用 profile：2/2。
- bridge、工具运行时、Shell、orchestration 和应用构建通过；边界检查通过。
- `npm run check` 仍在 `m14:capability:check` 的 `stale verification input binding` 退出，此前类型、边界、来源检查及 59 项 quick evaluation 通过。未重写历史能力证据，全量门禁未通过。

后续按 H4–H6 分别挂载真实 providers 并验证凭证、网络、浏览器进程、Node sandbox 与打包态；不能将本轮 fixture 成功视作这些能力已可用。


## 12. H4–H6 接入记录（2026-10-06）

本轮依次接入 Web、Browser、Node，在 Harness profile 中启用；上文第 5 节保留规划范围，
以下是实际交付边界。尚未完成 H4–H6 的全部发布验收，不将基础实现等同于 H8 放行。
本节记录接入时行为；之后的按需加载、进行中请求合并和结果投递优化见第 13 节。

### 已实现能力

- **Web**：`official.web.search` / `official.web.fetch` 使用官方 provider。每次搜索一个查询、
  最多 5 条来源，独立 Messages endpoint / model；凭证逐次从现有 resolver 获取，不进入工具
  参数、插件配置或 worker 环境。抓取保留官方公网地址及重定向校验，15 秒 provider 超时，
  256 KiB 响应上限、16,000 字符正文上限；工具总超时 30 秒。结果附来源、获取时间、截断和
  不可信内容标记。成功结果按 session / turn / 参数 / 凭证作用域缓存 60 秒，最多 64 条；
  endpoint / model 固定于该 provider 实例。同一请求完成后复用缓存，尚未合并进行中的请求。
- **搜索预算**：Host 在实际执行前从父任务预留 2,048 输出 token，预算不足不派发。
  已确认缺凭证或缓存命中释放该次预留；未知结果保留预留。官方 provider 不返回 usage，
  因而辅助用量、费用和任务总量标为未知，不能计成零；主模型已知消耗继续计入预算。
  这不是完整搜索账单或输入 token / 费用硬上限，也没有新增跨重启辅助费用对账账本。
- **Browser**：11 个审定工具：navigate、navigate_back、snapshot、click、type、press_key、
  console_messages、network_requests、find、resize、close。通过官方公共 session/MCP runtime
  延迟启动，首次获准调用才创建独立 Chromium，普通编辑会话不启动浏览器；无需 rebind。
  同一 live Session 复用并串行，不同 Session 隔离；取消初始化可清理后重建，关闭会话清理
  worker 和临时目录。导航/点击自动生成的快照文件展开为最多 24,000 字节的文本，减少一次
  单独读取。保留原生 schema 摘要校验及 H3 执行链，原生目录和 server instructions 不常驻提示。
- **Node**：`official.code.run` 使用官方 PTC 和所需服务，每次 fresh process / scratch。
  接受异步函数体和 JSON 输入，`await inputs.read({})` 获取输入；没有开放嵌套 Studio 工具。
  默认 30 秒、最多 120 秒，代码最多 32,000 字符，输出上限 24,000 字节，V8 old generation
  128 MiB（不是进程树内存上限）。官方文件沙箱之上叠加 macOS 读范围与网络限制、Node 权限；
  网络、子进程和项目目录读写均拒绝，不自动装 npm 包。至多 8 个顶层 UTF-8 普通文件，单文件
  16 KiB、总计 24,000 字节；拒绝链接/目录，产物经现有 OperationLog 存为引用后删除 scratch。
- **统一交互**：继续使用工具发现、代码参数预览、审批卡片、调用预算、取消和日志。外部动作
  单次审批，批准内容与执行参数摘要一致；不进入 Document Undo，也不计成项目修改。
  官方错误状态转换为失败记录，避免将 error/unavailable 记作成功。MCP Draft 2020-12 参数
  使用对应 Ajv 校验器，保留官方 schema。脚本错误保留脱敏、最多 512 字符的首行摘要供修复，
  不透传原始 provider 异常。取消时等待执行排空，不交付晚到成功结果。

### 配置及限制

应用主进程的 Harness profile 默认提供三类工具，启动进程时可分别设置
`AI_STUDIO_WEB_TOOLS=0`、`AI_STUDIO_BROWSER_TOOLS=0`、`AI_STUDIO_NODE_TOOLS=0` 禁用。
配置改变在下次应用启动生效；禁用不删除已有产物，也不撤销外部动作。Codex profile 暂不启用。

搜索可设置 `AI_STUDIO_SEARCH_BASE_URL` / `AI_STUDIO_SEARCH_MODEL`，默认官方 Messages 路由与
`deepseek-flash`；自定义 route 必须为不带凭证的 HTTPS URL，由部署配置控制。
浏览器可设置 `AI_STUDIO_BROWSER_EXECUTABLE`，否则使用官方 MCP 的 Chromium 查找机制。
需要预先存在兼容 Chromium；本轮实测使用本机 Google Chrome，没有自动下载浏览器。
Node 可设置 `AI_STUDIO_NODE_EXECUTABLE`，Electron macOS 下尝试已有 Homebrew / `/usr/local/bin/node`；
需要上游支持的 Node `^22.19.0 || >=24`。缺少独立 Node、完整沙箱或非 macOS 平台返回不可用，
不回退为无隔离执行。本轮实测 Node 24.19.0 / Electron 43.5.1，尚未验证正式安装包及签名路径。

浏览器截图/图像附件、文件上传、自定义文件输出及任意页面 JS 未开放；后续需要附件映射与图像
模型路由。Node 只绑定输入 JSON，后续如需调用 Studio 工具，仍须共享 Host 审批、预算和资源锁。
批量搜索可使用已有调度器并行独立调用，目前没有新增多查询工具或进行中请求合并；H7 仍待做
完整效率对照，不能据此宣称 token 或耗时改善百分比。

### 验证结果

- Bridge、官方工具运行时、accounting、Host 与 profile 定向回归 95/95 通过；补充启用全部扩展
  的 profile 生命周期/失败回滚后，profile + 配置开关测试 4/4 通过。补充脚本错误摘要后，
  官方工具 + Host 定向回归 24/24 通过；Web fixture 4/4 通过。
- 真实 Chrome / Node：普通 Node 下 5/5、Electron Node 模式下 5/5。覆盖延迟启动、导航/交互、
  会话隔离、初始化取消后重建、真实计算/文件捕获、环境清空、越界读写、可达本地服务器网络拒绝、
  子进程拒绝、死循环超时、输出超量、取消。这里使用 Electron 执行入口，不是完整 UI 或打包验收。
- 搜索使用真实官方 provider 加 HTTP Messages fixture，覆盖路由/认证、来源限额、缓存、缺凭证、
  429 错误脱敏与取消。没有使用用户凭证发起付费线上搜索。
- 公开抓取实测未通过：当前机器将 `example.com` 解析为 `198.18.0.168`，命中官方非公网地址
  拦截，返回 `WEB_BLOCKED_URL`。保留策略，未通过硬编码 IP 或放开私网绕过该环境问题。
- Bridge、工具、Runtime、Host 与应用构建通过；依赖来源和导入边界检查通过。
  `npm run check` 仍因既有 `m14:capability:check` 的 `stale verification input binding` 退出，
  此前类型、边界、来源及 59 项 quick evaluation 通过。未改写历史证据，未推进 milestone。

后续发布验证须补齐真实搜索、公网抓取环境、正式打包和所宣称的平台支持；截图附件和脚本嵌套
工具属于单独扩展，不能通过放宽 H3 审批或执行票据直接接入。

## 13. H7 按需加载、去重压缩、并行与事件等待（2026-10-06）

继续使用现有工具目录、Host、W4 结果投递和 W6/W7 调度，没有新增模型规划请求、执行器或审批入口。

| 改动 | 实际行为 | 保留的约束 |
| --- | --- | --- |
| 按需加载 | 普通编辑任务不再因模糊匹配携带 `official.*` schema；明确 Web/Browser/Node 意图只选必要入口。具体工具 ID 及 `tool.search` / `studio.tool.invoke` 仍可发现和调用完整目录。Web/Node 模块与服务在首次获准调用时加载，同能力并发首调共享初始化；浏览器仍首次调用才启动 worker。 | 工具选择只是上下文优化，不能授予权限。沿用任务稳定目录和正常重绑；owner 重建清空旧初始化 hook，不能复用已销毁服务。 |
| 请求去重 | 相同 session、turn、provider、参数和凭证作用域内的进行中 Web 请求共享一次 HTTP 调用；默认 `maxResults: 5` 与省略值归一。成功后复用原 60 秒缓存，进行中/已完成集合分别最多 64 项。 | 每个 Host 调用仍有独立调用记录和取消信号；一个等待者取消不影响其他等待者，最后一个取消中断并等待底层退出。错误不缓存，跨 turn/凭证不复用；共享成功沿用 `cached` 标记释放重复辅助输出预留。 |
| 结果压缩 | 同一批次已经成功交付的相同 Web 正文/来源改为调用引用；不同 URL、获取时间、正文或其他来源元数据不合并。外部来源、浏览器文本块和 Node 日志的连续精确重复按次数编码，可逐项还原。 | 不删来源、引用、状态、截断标记、文件产物或脚本返回值。模型投影预计至少节省 512 字节才应用；先落原始 CAS 和带字节计数的 durable 事件，再交付。错误、未知工具、未确认投递不作基线；无跨批次/跨 provider 的隐式记忆。 |
| 独立任务并行 | 审定的 Web 搜索/抓取加入项目无关读取白名单，可与低风险场景修改重叠；独立读取继续使用原 DAG、rolling 调度和并发上限。 | 依赖、明确 revision、审批、同一页面、脚本/运行时及未知副作用仍遵守原屏障。较大子任务继续走 W7 共享预算和收益资格，不为本轮优化默认启动多 Agent。 |
| 事件驱动等待 | 对话/预览初始同步后由 IPC 推送唤醒，成功时不再每 30 秒定时请求。刷新中多个通知合并成一次补刷；失败按 1/2/4/…/30 秒退避，成功后停止重试。窗口重新聚焦或恢复可见时校准一次。 | 保留单次在途请求和释放时取消 timer/listener。底层 DAG 本来即由 Promise 完成事件驱动；真实 deadline、失败重试和帧级投影合并 timer 不作为无效轮询删除。 |

`compactToolResults: false` 继续回退为完整模型结果，不改变工具实际执行和原始审计。
`AgentPollScheduler` 仍支持正数 interval 作为需要旧轮询的宿主回退；产品对话和预览使用 `null`。
三类外部能力的独立禁用开关保留。本轮没有自动生成子任务或猜测尚未产生的输入/产物引用。

验证记录：

- 调度、工具目录、W4/W6/W7、profile 与推送调度回归 **75/75** 通过。
- Web 按需加载、并发等价查询、跨 owner 重建及共享请求取消/清理 **9/9** 通过；官方工具执行票据相关定向集也通过。
- 真实 Harness + Host 的审批、预算、取消、重复结果交付、压缩关闭回退和 W4 原文恢复，加 Web fixture，共 **16/16** 通过。
- 真实 Chrome/Node 首次调用、隔离、网络与子进程拒绝、超时和取消 **5/5** 通过。
- 应用构建、契约、类型、包边界、依赖 pin 和 59 项 quick evaluation 通过。
  `npm run check` 仍在 `m14:capability:check` 因 `stale verification input binding` 退出；未重写历史验收报告或推进 milestone。

确定性证据是两个相同并发搜索只发送一次 HTTP、重复正文发送原文加引用、空闲成功状态不创建周期轮询。
这些本地 fixture / 进程测试不是线上 token、费用或端到端耗时的百分比验收；H8 仍需真实任务对照。

## 14. P2 实验入口与 alpha 隔离验证（2026-10-06）

用户选择“实现实验性入口，alpha 单独验证”。所有新实验入口默认关闭；生产依赖继续固定 RC。

| 入口 | 开启方式（主进程部署配置） | 本轮实际范围 |
| --- | --- | --- |
| 异步问答 | `AI_STUDIO_EXPERIMENTAL_ASYNC_QUESTIONS=1` | Harness profile 暴露 `studio.question.ask`，复用 Studio 问答卡片、原任务预算、调用结果和 Durable Session。立即返回 `pending`，每任务只允许一个待答问题；独立只读工作可继续，修改、外部副作用和验收等待答复。支持选项、自由输入、迟到答复及重启后恢复；重复/非法答复拒绝，显式取消关闭待答卡片。 |
| Chrome DevTools | `AI_STUDIO_EXPERIMENTAL_BROWSER=1` + `AI_STUDIO_BROWSER_BACKEND=chrome-devtools` | 固定官方 provider `0.2.0-rc.2` 和 `chrome-devtools-mcp@1.9.0`。复用官方 SessionResources/MCP 公共接口与现有执行票据，首次调用启动独立 headless Chrome。按任务发现 10 个审定工具；初始目录包括 list_pages、navigate、snapshot，原生 schema 每次执行校验。 |
| Team 准入检查 | `AI_STUDIO_EXPERIMENTAL_TEAM=1` | Team/团队/协作/并行任务暴露 `studio.team.inspect`，返回缺失条件。没有接入官方 Team 执行，没有开启新子代理；配置合格 W7 port 后仍走原 `studio.task.delegate` 逐次准入。 |
| alpha 验证 | `TMPDIR=/private/tmp node scripts/verify-harness-alpha.mjs 0.2.1-alpha.1` | 在临时目录安装和测试，不替换生产 package、lock、dist 或 profile；报告、安装日志、测试日志及候选 lock 留在该目录。 |

异步问答当前是 **Studio Host 的实验实现**，不是把 Harness `userQuestions.askTimed` 直接接到 UI。官方 timed question 依赖原生工具及 Session projection；当前 Host 的 backend question 分支会释放整个 provider turn。直接复用会错误地阻塞独立读取，因此保留 Studio 的唯一持久记录和任务所有权，未来再适配官方 question stream。现在仅支持一个问题、2–3 个建议答案，未实现官方前台倒计时/attachWait。问答答复不授予高风险操作或额外预算。运行中收到答复时排入原任务的下一回合，当前回合必须先退出，不插入并发模型请求。

Chrome DevTools 的初始 pageId 由 list_pages 获取。禁止 attach 到用户浏览器、任意文件路径、initScript、上传、JS evaluate、未知参数和非 HTTP(S) 导航。使用统计和性能 CrUX 请求关闭。所有改变页面的工具仍需精确审批；截图二进制暂未接入。Playwright 保持默认；删除实验配置即可回退。Stagehand 暂不接入，其额外推理路由、凭证和费用归属仍需与主账本适配。

官方 Team 注入 `agents/sessions/sessionPersistence/sessionProjections/subagents`，有自己的持久成员、任务板和恢复逻辑。Studio 尚未提供该持久化/子代理适配，因此 Team 状态明确为 unavailable，不把 W7 伪装成官方 Team。后续执行接入须先实现单一 Session/task 权威映射、父预算预留与真实退出回收、只读候选产物权限和真实 provider A/B 准入证据。

alpha 隔离结果：

- `0.2.1-alpha.1` 需要 Cordis `4.0.5-alpha.1`；保留 RC Cordis 时 npm 明确报 peer 冲突。
- 补齐 alpha 闭包后，复制当前编译后的 bridge，并使用已审定 Editor 包运行 Messages、Session V4、初始化/取消、工具 guard、并发读取、上下文重建/回滚及 Web 去重测试：**56/56 通过**。生产 lock 摘要未变。
- 候选版本/integrity 与报告摘要保存于 `config/upstream/harness-alpha-candidate.json`。这是桥接运行时兼容验证，未做 alpha 全应用类型迁移、真实在线模型、Electron/browser/Node 进程矩阵或恢复验收；尚不能据此切换生产。
- 未来 alpha 升级仍需重审 Cordis/cosmokit/schemastery 闭包、移除旧 invariant 相关 overrides、更新 license snapshot/pins，并通过 H8。禁止使用 `--force` 或 `--legacy-peer-deps` 掩盖依赖冲突。

本轮验证：异步问答（含活动中重启和显式取消）、W7、结果压缩、UI、目录与配置定向集 **63/63** 通过；新增 UI 自由输入回归通过；问答最后补测（含答复与取消竞态）**7/7** 通过；两种真实浏览器隔离/取消/重建共 **4/4** 通过。应用构建、契约、类型、包边界、upstream pins 与 **59** 项 quick evaluation 通过。`npm run check` 仍停在历史 capability 证据的 `stale verification input binding`，未覆盖写入旧验收报告或推进 milestone。

官方接口依据：[User Questions](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/subsystems/user-questions.md)、[Chrome provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/experimental/browser-use-chrome-devtools-mcp/README.md)、[Team](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/experimental/agent-team/README.md)。

## 15. P0 续跑恢复与官方工具执行回执（2026-10-07）

本轮修复实验入口继续推广前的可靠性问题，保持现有审批、预算、任务所有权和单一调度器。

- 异步回答、持久审批、恢复后的计划和预算选择将续跑参数保存为有版本的 CAS 记录；决定与引用写在同一条 Session resolution 中，避免“已回答，但续跑只存在于内存队列”。记录保留原任务、已批准计划、补充信息和明确的预算选择。
- 续跑开始前先写领取事实。未领取的记录在初始化完成后自动回到原队列；已领取而未确认结束的记录显示 `continuation.interrupted`，由现有检查点恢复入口接续，不自动重放可能已产生副作用的工作。并发提交同一交互只允许一个处理者，取消竞态不生成新工作。这里不宣称跨外部系统的 exactly-once。
- 最近聊天记录仍有显示上限，但未决问题、计划和授权单独保留。恢复扫描全部仍保留的日志，按有界序列窗口处理；先归并事实，再读取近期节点和未决交互的内容。任务按最新投影恢复，兼容旧记录缺少索引字段的情况。
- 官方工具增加 `OfficialToolReceiptV1`，分别记录 execution（completed / unknown / not-started）和 delivery（available / unavailable）。派发前先记事实；结果过大、类型不支持、Host 校验失败、执行后取消及后置策略失败均保留脱敏回执和有界文本预览，预览由 Host 从结构化结果按原字段路径脱敏后截断，不直接保存 provider 渲染文本；先保存 artifact 再发布引用。
- 同任务、同工具版本、同参数的外部操作存在未决执行结果时，拒绝自动再次派发，重建 runtime 后仍生效；热运行时按日志序列增量读取新导入的项目历史，避免缓存漏掉未决操作。明确未启动的调用可重新准备；已成功交付的操作不被永久封锁；只读调用可重试。Node 脚本和浏览器副作用继续走原审批。
- 错误的 summary / digest 投影保留执行状态、预览、artifact 引用和禁止自动重复的提示，不把这类结果送入参数修正重试。
- 全量门禁越过过期能力证据后，修复 320 像素窄窗口中计划批准按钮被裁剪的问题；授权说明完整跨列显示，摘要可滚动，提交中状态在重绘后继续防止重复提交。同步纠正旧集成夹具对无条件项目读取、原尺寸分析截图及已提交计划节点复用的过时假设，保留运行视口、画面内容和审批语义断言。

`delivery` 在该工具契约中表示桥接结果可被 Host 接收。更外层 Backend 投递仍使用现有 `tool.outcome-unknown` 事实和恢复流程；二进制截图附件、官方 Team 执行和 alpha 生产升级不在本轮扩展范围。

验证与证据更新见 [P0 验证记录](../evidence/p0-reliability/2026-10-07/README.md)。旧 capability census 和 verification 已保存在该目录的 `before/` 下；当前证据由正式 capture 命令重新生成，未手工调整摘要或验收门槛。

最终 capability capture **345/345 通过**；全量 check 越过旧 stale evidence 门禁并完成 74 文件集成清单，**408 通过 / 1 失败**，无跳过或取消。唯一失败是大项目性能验收要求指定 Windows 10 / i7-7700 基准机，当前 macOS 不匹配；保持门槛，未宣称全量验收通过。全部本轮 TAP 与汇总保存于验证记录目录，既有设备验收产物保留原版本。

## 16. P1：步骤级等待、按需结果和产品入口（2026-10-07）

本轮在第 15 节 P0 恢复与回执基础上实施，保留唯一 Host / Session / TaskAccount / Document History。

- **问题依赖**：`studio.question.ask.blockedStepIds` 使用已批准的 plan item ID；Host 根据原有 `PlanTaskV1.dependsOn` 计算传递阻塞。依赖步骤不能被报告为开始或完成，不能参与候选委派。没有完整图时保留整项任务的写入屏障。第一批放行范围是已标记 `in_progress`、依赖已完成、实体 read/write scopes 与等待步骤不相交的 `transform.set` / `material.set`；其他修改和外部动作仍等待答复。仍需原有精确修订、工具审批和约束校验。答复入队但尚未进入下一轮时继续阻止写入，避免使用尚未读取的新约束。
- **结果按需读取**：成功的官方工具结果超过 8 KiB 时保存完整脱敏 CAS，默认返回摘要、来源、digest、大小、修订和期限。`studio.result.read` 支持 offset / length，单段最多 8192 个 JavaScript 字符，返回 nextOffset。CAS ID 本身不是读取授权；引用必须由当前会话发放，且文档、revision、工具权限摘要与 60 秒有效期匹配。浏览器引用额外限制在原 turn。历史原件仍保留在日志产物中。不会为了获取过期外部动作结果而重做动作。
- **跨回合复用**：先开放匿名 `official.web.fetch`；命中有效记录直接交付引用，跳过 provider 执行，但仍经过 Host 预算、调用事件和交付记录。搜索凭据、浏览器状态和 Node 副作用没有充分跨回合失效证明，因此不缓存执行。恢复查询限定 TTL 时间窗口、页数和容量，失效或查询预算不足退回正常匿名抓取。`agent/result-savings` 记录实际投递前后字节，不把字节估计标为 provider token 用量。
- **工具设置**：设置页新增 web/browser/node 开关、Playwright / 实验 Chrome DevTools 选择、实际启用状态和环境不可用原因。偏好保存到设备 `tool-preferences.json`，重启应用生效；部署环境变量的关闭开关优先。Main 检测浏览器可执行文件及 Node 22+ permission flag / macOS sandbox；不可用工具不进入注册表。Renderer 无执行路径/秘密输入能力。浏览器模型 schema 移除 filename / filePath / initScript 并拒绝未知参数，Bridge 仍使用未修改的 native catalog 验证上游漂移。
- **候选并行产品接入**：`AI_STUDIO_EXPERIMENTAL_PARALLEL=1` 时读取设备 userData 下的 `parallel-qualification.json`。绑定安装后 JS/JSON 与 lockfile 的 build digest，不能仅用 Git HEAD 掩盖未提交修改。成功加载与当前构建匹配且未过期的证据包后展示 delegate 入口；每次调用仍验证模型、prompt profile、tool registry、任务独立性、输入引用、预算及真实对照证据。现有调度器最多同时执行 2 个无工具子任务、每批 2–4 个；候选状态使用现有 progress 节点、候选存 CAS，取消等待真实退出。当前产品 cohort 为独立产物研究；输入使用父会话已发放且仍有效的结果产物引用，缺少引用、超出事实预算或其他任务类别均退回父任务。父任务负责核验和通过普通工具合并，子任务不能直接写 Document，候选不自动成为验收证据。费用、tokens 和取消继续归属于父 TaskAccount；未知成本保留预留，不当作零。

资格文件是设备运维输入，模型和 renderer 不能写入。版本 1 的精确字段：`schemaVersion: 1, sourceRevision: <parallelBuildIdentity 返回值>, cohort: "independent-artifact-research-v1", expiresAt: <毫秒时间戳>, reportRef: <CAS ref>, artifacts: [{ref, value}]`，最大 256 KiB。每个 ref 必须等于 value 的 canonical SHA-256；整个不可变证据包留存到当前项目日志。report/value 继续执行 `subtask-qualification.ts` 的严格证据规范：至少 5 对真实 provider trials，包含 parent / children / merge 的最终 Usage/Cost、质量全部通过，延迟中位数比 ≤ 0.9，累计 tokens 与成本中位数均不回退。配置入口不代表已取得生产资格。本轮未发送付费模型请求、未生成真实 A/B 证据，因此默认仍关闭并行。

验证记录见 `docs/evidence/p1-efficiency/2026-10-07/README.md`。不能用合成测试声称生产 token 或质量收益，也不替代原 Windows 指定机器性能门禁。

## 17. P2 实验能力准入与 alpha 全栈验证（2026-10-07）

P2 的完整目标仍是官方 Team 的单一持久任务归属、Stagehand 额外推理计费，以及隔离 alpha 的源码/应用/进程验证。以下区分已实现适配与尚未开放的原生执行，不能将门禁或只读入口记作官方插件已接入。

- Team 的 `studio.team.inspect` 直接投影当前已批准计划的 step/task id、执行状态、依赖与写入范围，返回脱离原对象的只读数据。不生成另一套 Team task id、revision、owner 或任务板。`nativeAdmission: blocked` 与 W7 的 `qualification-required` 分开，配置候选端口并不代表官方 Team 已准入。
- 固定 rc.2 的 Team 经 `TeamJournal` 向 Lead Session 写入成员、消息和任务事件，经 `subagents` 恢复并投递消息。完整挂载还需要 Studio 的 Session persistence/continuation 适配：所有恢复后请求必须重新经过父任务预算、取消和资格校验，且既有计划状态与官方任务板只能保留一个权威写入端。本轮未挂载原生 Team 服务或自动恢复调度。
- 额外推理可按 input/output/cost 三项预留父任务预算，并绑定同一 canonical UsageLedger 与现有 PricingEngine；其他任务的 ledger、未结束的请求、缺少最终用量或未知价格均不能结算。绑定后不能通过“未发送”释放预留。任一额外推理未结算时，任务 token 总量与费用保持 unknown/null，cost.final=false；取消不会被当作零成本。已有 Web 搜索的有界输出预留保持兼容。
- 固定 `dsh-experimental-browser-use-stagehand-native@0.2.0-rc.2` 的 Config 仅提供原生 model/credential、浏览器与 operation timeout，未暴露自定义推理回调。后续深入验证确认：底层 Stagehand 4.1.0 已提供 `ClientLLM.generate` 和操作用量，先前仅根据 Harness 声明作出的判断不完整，见第 19 节。当前仍未接入 Studio 逐请求预算、取消和账本；原生执行不注册，未知 backend 显式拒绝。
- alpha runner 现在复制源代码及完整构建资源，排除旧 dist/node_modules/test-output。在临时 workspace 更新候选闭包，删除退役 invariants override，固定 Cordis/cosmokit/schemastery，验证单实例、版本、MIT license 和完整性。依次执行全应用构建、各 workspace 源码类型检查、bridge 测试、Session/压缩/continuation 恢复测试、真实 Electron/Playwright/DevTools/受限 Node 进程矩阵。每阶段有退出码、日志摘要与时限，缺少任一阶段不得 passed。保留源码摘要、候选 lock 摘要，并验证生产三个依赖文件未改变。

验证结果与固定上游声明证据见 `docs/evidence/p2-experimental/2026-10-07/`。未调用付费模型，未将 alpha 提升为生产版本，未放宽 W7 的实测资格门槛；正式 Team/Stagehand 原生执行仍属于 P2 未完成项。

## 18. Team 持久化与恢复准入适配（2026-10-07）

本次补齐的是显式 opt-in 的适配层，使用固定 rc.2 官方 Team / Subagent / Session Query；不发布原生 Team 工具、不新建产品任务板，也不将 W7 的一次性候选资格当作持久 Team 资格。生产默认关闭。代码和验收范围见 [Team 恢复记录](../evidence/team-recovery/2026-10-07/README.md)。

- `createTeamSessionJournal` 复用现有 Operation Log + CAS，按 Session 保存有界增量帧与前驱摘要，写入必须持有 composition 提供的独占恢复 lease。缺失日志前缀、产物、版本不匹配、并发写入及参数脱敏会拒绝恢复。使用完整保留的 journal；已轮转丢失前缀的日志不能被当作新会话。
- `StudioTeamPersistence` 实现官方 SessionPersistence，append 在内存保持可读，flush / close 批量持久化；原生 Agent、Team flush 和冷恢复读句柄都走同一 adapter。保留原始 seq、成员、任务 CAS 与消息身份；assistant 的隐藏 reasoning 和逐 token stream 不持久化。没有另开 JSONL 或数据库。
- `teamRecovery: { journal, admission }` 在同一 Harness transport 生命周期安装适配；打开已存在的 Session 使用官方 resume。恢复投递需要的 Session Query 只使用官方精确读取，不注册搜索或模型工具。新增依赖闭包保持 rc.2、MIT、精确 overrides / lock；依赖中出现 compaction/todo 不表示挂载它们。
- `StudioTeamRecoveryAdmission` 将 Lead/成员身份绑定现有 parentTaskId、budgetId、planTaskId、model；保存绑定不授予执行权。每次模型请求（包括 Lead 直接 steer 和冷队友）都重新调用 Host authority，检查预算、输入字节保守上界、输出上限、已知价格及父任务取消。此阶段仅允许无工具推理；编辑仍由父任务普通工具和审批处理。
- 请求预留及开始记录在付费调用之前落盘，使用现有父 TaskAccount / UsageLedger，保留缓存输入的正确总量。settle 只在真实 stream 退出后执行；未知费用保持预留，重启不自动重发结果不明的请求。已结算历史也要求 Host 提供已恢复的父 ledger，缺少账本时返回 reconciliation-required，不从零继续计费。

产品后续接线仍需：绑定真实父会话及批准计划、恢复父任务完整账本、设备级 writer lease、Team 专属真实 provider 资格，以及确认 Lead 的普通 runtime 账本和 Team 请求账本只有一个计费 owner。当前导出的 opt-in transport 由 Team admission 负责计费，不能再将同一请求作为另一笔 runtime 费用重复入账。默认 `studio.team.inspect` 继续只读投影 Studio 计划，明确区分 adapter available 与 product mounted。

## 19. Stagehand 底层推理钩子验证（2026-10-07）

已在固定 Stagehand 4.1.0 发布包、真实 Chromium 扩展及 rc.2 Harness Worker 上验证 `Stagehand.create({ model: { generate } })`。这是 v4 的 `ClientLLM`，不是 v3 的顶层 `llmClient`。SDK 无需 fork；Harness Worker 需要开放回调通道。验证、源文件摘要、锁定依赖和可复现小补丁见 [Stagehand SDK 记录](../evidence/stagehand-sdk/2026-10-07/README.md)。

- 自定义回调实际位于 SDK 进程，扩展通过 `llm.generate` RPC 请求；观察、点击、提取都能经过 Host。提取实测包含内容提取和完成度判断两次调用。
- 原生结果有 `metadata.usage` 汇总。缺失 usage 会被 SDK 汇总为零，操作失败可能不返回之前成功调用的聚合，所以正式计费必须以 Host 每次生成的 provider usage 为准，汇总只核对、不得重复入账。
- 回调没有内置 AbortSignal 或输出 token 上限；Host 必须捕获父调用身份，逐次预留预算、设置 provider 输出上限、处理取消并等待真实请求结束。费用未知不能释放预留或自动重发。
- 隔离补丁只改 Worker 模型入口为 MessagePort 回调，保留原操作分发及校验；不复制浏览器实现、不修改 SDK。源文件摘要或替换锚点变化即拒绝应用。原生凭证路由和逐操作模型覆盖禁止回退，凭证留在 Host。

当前是底层能力与补丁原型验证，生产 manifests/lock/工具注册未变。正式接入还需现有 Tool Host 精确审批、TaskAccount/UsageLedger 与持久调用记录接线、Worker 生命周期取消排空，以及实际 provider 的输出限额/用量验证。该结果解除“SDK 缺少扩展点”的技术疑问，不将模拟模型数据认定为真实费用或生产资格。
