# Engine、Harness、UI 与 GPT 模型升级方案

核查日期：2026-11-21（Asia/Shanghai）。AIStudio 基线：`357d108da40b34b43c121e276bc1fda815add161`。

实施结果见 [依赖与模型升级验证](../evidence/dependency-upgrade-result-2026-11-21.md)，首次安装过程另记于 [依赖升级实施预检](../evidence/dependency-upgrade-preflight-2026-11-21.md)；下面保留制定方案时的版本与验证边界。

本次产出是代码影响审计与实施方案；尚未替换生产依赖、调用真实模型或推进 milestone。机器可读核查记录见 [依赖审计记录](../evidence/dependency-upgrade-audit-2026-11-21.json)。本方案更新了 [10 月 Harness 规划](harness-upgrade-and-extended-tools-plan.md)中的版本选择，历史实现和验收记录继续保留。

## 1. 推荐目标与实施顺序

建议拆成独立可验收的变更：**先完成 Codex/GPT 6.2，再升级 Engine 与 UI/Editor 候选，最后迁移 Harness 并做组合回归**。GPT 走独立的 Codex 后端，不必等待 Harness 大版本适配。

| 范围 | 当前 AIStudio | 已核实的上游状态 | 推荐目标 |
| --- | --- | --- | --- |
| Engine | `0.1.0` 正交拾取补丁候选 | npm / GitHub `0.2.3` | `@haiyue/engine@0.2.3` |
| 扩展运行时 | `@haiyue/extensions@0.1.0` | npm `0.2.3`；要求 Engine `>=0.2.3 <0.3.0`、animation-spec `>=0.2.2 <0.3.0` | extensions `0.2.3` + animation-spec `0.2.2`，作为同一兼容集合升级 |
| Shader 工具链 | AIStudio 未直接依赖 | npm `@haiyue/shader-language@0.2.3` | 记录对应版本；只有实际消费 shader 工具链时才新增依赖 |
| Harness | `dsh-v0.2.0-rc.2` / Cordis `4.0.4` | 发布 `dsh-v0.2.2-rc.5` / Cordis `4.1.0` | 精确固定这一 RC 兼容闭包，重新准入 |
| Codex App Server | `@openai/codex@0.148.0` | npm / GitHub 稳定版 `0.171.0` 已加入 GPT 6.2 Astra/Sol | `0.171.0`，同步生成该版本 wire schemas |
| UI | `0.1.4-expandable` 本地候选 | npm 最新 `0.2.2`；GitHub Release 与本地 manifest 为 `0.2.3`，npm 精确查询 `0.2.3` 返回 404 | 最新源码目标为经过评审的新 `0.2.3` 候选；可独立交付的已发布基线为 `0.2.2` |
| Editor 基础包 | sdk/platform/app-kit `0.1.0`，shell `0.1.1` | 当前 npm 查询四个包均返回 404，继续依靠受审候选 | 至少重发兼容 UI 0.2.x 的 editor-shell 候选，并保留 advanced-authoring 接口 |

版本依据：[Engine 0.2.3 发布说明](https://github.com/HaiyueStudio/Engine/releases/tag/v0.2.3)、[Harness rc.5 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5)、[Codex 0.171.0 发布说明](https://github.com/openai/codex/releases/tag/rust-v0.171.0)、[UI 0.2.3 发布说明](https://github.com/HaiyueStudio/UI/releases/tag/v0.2.3)、[UI npm 元数据](https://registry.npmjs.org/@haiyue%2Fui)。实施时再次查询版本并冻结，不在产品启动时追随浮动标签。

注意三个版本陷阱：

- Harness 的 `dsh-agent@latest` 仍指向 `0.1.0-rc.6`，`next` 才是 `0.2.2-rc.5`；新增 executor 的 latest 也可能是旧 alpha。必须按精确版本更新整个闭包。
- 本机 `D:/HaiyueStudio/Engine` 是干净的 `1090368abf688a0d60bd54632b45000fa048336d7`、manifest `0.2.2`，落后于已发布的 Engine 0.2.3。不能拿本机旧 dist 代替新版包。
- 本机 UI 是干净的 `f0f838af44a5f5dc86aa441cf517d7128d4e3f57`、manifest `0.2.3`，还包含发布标签之后的 design tokens 工作。新候选必须明确绑定具体 revision、重新跑准入；不能仅凭 `.artifacts` 中的文件名选取包，也不能将 GitHub Release 等同于 npm 已发布。

## 2. 已确认的代码影响

### 2.1 Engine：目前以兼容验证、文档与候选更新为主

已下载并校验 npm 原始 tarball 的 SHA-512 integrity，静态比较 AIStudio 源码中的 **65 条 import 声明、215 处具名导入引用**：在 Engine `0.2.3`、extensions `0.2.3`、animation-spec `0.2.2`、UI `0.2.2` 的公开声明中均能找到。该结果是静态导出检查，尚不等于 TypeScript 全量编译或 GPU 行为通过，也不覆盖尚未生成的 UI 0.2.3 候选。

定向声明比较中，`HaiyueEngine`、`InteractionSystem`、`ScriptRuntimeContract` 未发现所比较的非注释声明行变化；Scene 的渲染 accessor 改为重导出，Physics 有新增声明。现阶段没有依据要求重写整个编辑器适配层。

| 文件 / 范围 | 应做的调整或验证 |
| --- | --- |
| 根 `package.json`、`package-lock.json`、`packages/editor-plugins/package.json`、`packages/script-preview/package.json`、`apps/ai-studio/package.json` | 同步升级所有 Engine/扩展/animation-spec 版本；避免 workspace 中保留第二套 0.1.x 运行时 |
| `vendor/`、`config/engine-candidate.json`、`config/render-extension-candidates.json` | 将核验过的发布包作为新候选纳入现有 vendor 流程；更新版本、来源 revision、SHA-256、npm integrity 与 required exports |
| `apps/ai-studio/src/renderer.ts`、`preview-runtime.ts` | 验证创建/切换 Scene、手动帧提交、设备丢失恢复、DPR/resize、InteractionSystem 输入归属、停止/重启后的释放 |
| `apps/ai-studio/src/scene-entity-rendering.ts`、`scene-material-textures.ts`、`packages/editor-plugins/src/scene-authoring.ts`、`render/` | 验证 geometry、透明材质、PBR、纹理、灯光、圆角体和平面；experimental 导出仍存在，但应逐项验证行为 |
| `apps/ai-studio/src/physics-play-runtime.ts`、`play-simulation.ts`、`play-transforms.ts` | 验证固定步长、接触事件、raycast、Rapier 后端、replay 及物理资源快照 |
| `packages/script-preview/src/index.ts`、`effects/render-effects-runtime.ts` | 验证脚本 runtime、粒子、音频、glTF、2D/3D 动画、后处理、异步加载取消及资源 owner |
| `vendor/haiyue-engine-reference-docs.json`、`config/engine-docs-source.json`、`scripts/build-engine-docs.mjs` | 同步更新引擎文档及 integrity 绑定，重建实际生成的知识索引；避免模型继续按 0.1.0 文档调用新引擎 |
| `apps/ai-studio/src/behavior-adapters.ts`、M14 capability / behavior evidence | 包版本和 bundle digest 会改变；重新采集当前证据，不把旧证据直接改版本后继续使用 |

`vendor/patches/engine-orthographic-picking.patch` 对应的正交射线分支，已在 npm Engine 0.2.3 的实际 Ray chunk 中发现。实施时应先跑透视/正交、reverseZ、resize、移动相机的拾取回归，再删除新 candidate 对旧 compiled chunk / 补丁的依赖；历史补丁与基线可保留供追溯。不能将旧 Ray chunk 文件名硬套到新版包。

Engine 0.2.3 新增 scene-flow、character2d、camera2d、input-actions、音频等公开入口。本轮先保持已有 Studio 能力可用；新增引擎能力进入 Agent 工具前，仍需经过 ComponentRegistry、Document 操作、runtime adapter、observation/evaluation 的正式接入，不能直接把 Engine API 暴露给模型。

### 2.2 UI：Editor Shell 的依赖约束必须一起处理

当前 vendored `@haiyue/editor-shell@0.1.1` 在 **dependencies** 中声明 `@haiyue/ui: >=0.1.0 <0.2.0`。仅把根 UI 升为 0.2.x，可能产生第二份旧 UI，继而出现重复 custom-element 注册、类型或样式分裂。不能通过盲目 override 声称该兼容性已经成立。

1. 从对应 Editor 源码/发布负责人取得新 shell 候选，完成 UI 0.2.x 的依赖范围、公开 API 和真实消费验证；必要时同步其 sdk/platform/app-kit 版本。当前机器没有 `D:/HaiyueStudio/Editor` 工作区，不能在本仓猜造上游修复。
2. 新候选必须继续提供 `./advanced-authoring`、`./advanced-authoring.css` 和现有 generic Editor 服务边界。`apps/ai-studio/src/editor-panels.ts` 与 `scripts/copy-assets.mjs` 已实际使用这两个子路径。
3. 将 UI 0.2.3 的目标 revision 打包、评审并记录 `config/upstream/ui-candidate.json`；若先交付 npm 0.2.2，应在变更标题与验收中明确这一阶段目标。
4. 同步 `config/upstream/editor-candidates.json`，保留包 provenance；验证安装树中只有一份符合目标的 UI。

主要消费位置：`apps/ai-studio/src/renderer.ts`、`editor-panels.ts`，`packages/studio-shell/src/workspace/workspace.ts`、`panels/chat/index.ts`、`panels/resources/panel.ts`。继续按组件子路径显式注册，不切换为全量 root 注册。

对已发布 UI 0.2.2 的比较中，Split、Tree、Drawer、Select、Expandable 未发现所比较的非注释声明行移除；Tabs/Dialog 增加了 opt-in controlled 模式。无需为了升级强制改写成 controlled。必须回归窄资源面板中的横向滚动、键盘/ARIA、焦点与 Esc、嵌套 Shadow DOM 展开、拖动分隔面板、断开重连及主题 token。历史 scrollable-tabs / expandable 补丁只有在新版对应行为通过后才从当前候选绑定中退出。

### 2.3 Harness：存在已确认的 API 迁移，风险最高

目标 tag `dsh-v0.2.2-rc.5` 对应 commit `9c2670d3bce5275e0d1610272958121af87787bb`。上游已要求 Node `>=24.9.0`；当前执行环境为 `24.21.0`，但仓库 `.node-version` 与 workspace engines 仍以 `22.19.0` 为最低值。需要统一开发/CI 运行时，并单独检查 Electron 内嵌 Node，不能用宿主 Node 版本代替 Electron 兼容性结论。[迁移依据](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)

| 当前代码 | 已确认变化 | 迁移动作 |
| --- | --- | --- |
| `packages/harness-bridge/src/index.ts`、`ownership.ts`、`conformance.ts` 的 Cordis root / Fiber / effect 适配 | Cordis 升为 4.1，配置和 Fiber 访问机制有更新 | 定向审查 plugin 加载、配置解析、scope 身份和 dispose；继续保持唯一 root，不在其他包重新实例化 Cordis |
| `packages/harness-bridge/src/harness-agent.ts` 导入 `ModelSelectionRef`，调用 `installModelSelection(agentContext, selection)`，写 `selection.current` | 新版公开入口以 `AgentModel` / `agent.model.current()`、`select()` 管理选择；`installModelSelection` 只接收一个 context 参数，步骤准备前固定模型 | 移除旧 selection ref 依赖，在 step admission 前使用 `agent.model.select()`；同步 reasoning、maxTokens、重试和会话重绑语义 |
| 同文件安装 `ToolRuntime` 时传 `{ mode: 'native', maxParallelSubCalls }` | 新版移除旧 tools.mode，执行器拆为 `@deepseek-ai/dsh-tool-executor-native` / `dsh-tool-executor-ptc` | 显式安装需要的 executor；迁移并发配置，不仅改包版本 |
| `official-tools.ts` 调 `tools.execute({ callId, rootCallId, name, arguments, ... })` | 新版 execute 接收 `ToolBatchInput`，包括 `calls`、`signal`、`agent`、可选 `toolSet` / `log`，返回批次结果 | 重写 batch 输入/结果适配；审查 ToolExecutionToken、guard、pre/post-execute 钩子与错误类型；保留一次授权、schema digest、未知执行结果等约束 |
| `harness-agent.ts` 的 Session / Projection setup，`request-context.ts` 的 Surface 维护 | projection 注册变为异步 handle；Session 增加批量 append；单事件 append 仍可用 | 等待注册就绪后发布 Agent，持有并释放 handle；检查测试包装器及 batch 事件排序，不把所有单事件调用机械改为数组 |
| `team-recovery.ts` 导入 `dsh-experimental-agent-team`，`team-persistence.ts` 实现存储 | 旧包不存在于 rc.5；新包为 `@deepseek-ai/dsh-agent-team`，Subagent 名称、目录载荷与 Team 任务归属发生变化 | 替换包与适配，覆盖恢复/父子预算/取消；即使入口默认关闭，静态导入也必须能编译；不因包转正而自动开放产品能力 |
| `extended-web.ts` 显式使用 `deepseek-official` 搜索与 http fetch | 新默认搜索路由已变；旧搜索 provider 仍存在；新版 HTTP Fetch 放宽了对非公网地址的限制 | 首轮可显式保留旧搜索行为，另外评审新 Search API 的凭据/计费/ori_question；由 Studio 继续保证现有公网地址与重定向限制，不能把移除的上游网络限制当作仍然存在 |
| `extended-node.ts`、`extended-browser.ts`、browser/devtools catalog | Node PTC、取消错误、MCP/Stagehand 与工具 schemas 有跨版本变化 | 按实际使用的 provider 重取 catalog、校验 schema digest，测试原生依赖、子进程、取消与关闭；不直接复用旧录制数据 |

具体上游说明：[模型固定与执行器拆分](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)、[Session append 重载](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/upgrade-guide/v0.2.2-rc.1/session-append-overloads/guide.zh.md)、[Subagent 名称与持久化](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/upgrade-guide/v0.2.2-alpha.3/subagent-names/guide.zh.md)、[搜索默认提供方](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/upgrade-guide/v0.2.2-alpha.2/web-search-default-provider/guide.zh.md)。

需同步的版本与准入文件：根 overrides、`packages/harness-bridge/package.json`、lockfile、`config/upstream/pins.json`、`compatibility.json`、LICENSE/NOTICE 快照、`packages/agent-backends/src/harness-backend.ts` 的协议标识及相关测试。`scripts/verify-upstream-pins.mjs` 仍硬编码旧 commit 和 Cordis `4.0.4`，要改为核验新冻结基线，并继续拒绝嵌套旧 DSH/Cordis 实例。

已有 `harness-alpha-candidate.json` 的 0.2.1-alpha.1 隔离验证通过，只能作为测试清单参考。它不覆盖 rc.5，也不是生产准入许可。

## 3. GPT 6.2 的具体接入方案

### 3.1 模型发现与实际调用

当前 GPT 路径是 `CodexAppServerBackend`，通过本地 Codex App Server 的 `model/list`、`thread/start`、`turn/start` 调用。这里没有生产 GPT-5.6 静态白名单；5.6 字符串主要出现在计价表和测试 fixture。更新计价表或手填下拉框不能让旧后端真正支持新模型。

1. 根与 `packages/agent-backends/package.json` 同步固定 `@openai/codex@0.171.0`。更新 `codex-backend.ts` 的 upstream / protocolVersion。
2. 修改 `scripts/generate-codex-schema.mjs` 中的版本输出目录，用该版本二进制重新生成 JSON Schema 与 TypeScript；更新 `pins.json` 的 schema/type 数量与 tree hash，逐项审查动态工具、登录、权限、usage、rate limits、thread resume 等协议差异。生成类型仍只归 agent-backends 所有。
3. 继续以当前账号的 provider catalog 为可用模型真值，支持 `gpt-6.2-sol`、`gpt-6.2-astra`；6.1 Terra、旧 Sol 等其他可用模型也自然随 catalog 出现，不再维护产品端代际白名单。
4. 修复 `loadModelCatalog()` 只取 `limit:100` 第一页的问题，使用 `nextCursor` 做有界分页，检查循环 cursor、数量上限及重复 id。
5. `modelCatalogPromise` 成功后目前长期缓存，`refreshBackends()` 再调用仍会得到旧目录。增加显式失效/刷新语义，在登录、登出、重连、进程重启及有限缓存期限后重新获取；取消或旧账号返回的迟到结果不得覆盖当前目录。
6. 新会话默认优先使用 provider 标记的默认模型（0.171.0 的发布目录为 Sol）；Astra 用于用户选择的复杂任务。已明确选择的模型消失时显示不可用诊断，不能在 `refreshBackends()` 中悄悄改选另一模型；只对未设置偏好的新会话采用默认值。
7. 保留 thread/turn 请求中的精确 model 与 `allowProviderModelFallback:false`。模型可见性不等于当前账号有调用权限，真实拒绝须归一化并在 UI 可见。

模型标识依据：[GPT 6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra)、[GPT 6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol)。最新 model/list 还包含 provider 和 service tiers 元数据，解析器应按新版边界校验已消费字段，不把原始 payload 传给 renderer。[0.171.0 Model 定义](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server-protocol/schema/typescript/v2/Model.ts)

### 3.2 推理等级、速度与 token 限制

当前 `normalizeCodexEffort()` 将 `xhigh`、`max`、`ultra` 合并为一个 `xhigh` key；若目录同时返回多个等级，后面的等级会被丢弃。这会使用户无法区分等级，也会把审计中记录的等级与实际 wire 参数混在一起。

- 以 `packages/studio-contracts/src/m12.ts` 和 `config/contracts/m12-contract-index.json` 为唯一契约入口，评审独立 `max` 的表示；同步 turn-config / negotiation schema、fixtures、runtime validator、shell read-model/intent 校验及测试。旧持久化配置继续可读。
- 正常推理等级按 provider 逐项协商、精确映射；不支持的值明确拒绝或带诊断降级。GPT 6.2 不接受 `none`，不能把 `off` 强行传过去。
- `ultra` 不只是名称更高的单 Agent 档位，上游文档将其描述为会使用 subagents。当前 Codex 后端明确关闭 `multi_agent`，所以本轮移除其到 xhigh 的静默映射；只有完成 Studio 子任务、预算、取消和持久化准入后才考虑开放 Ultra，未准入时提供明确诊断。[Ultra 行为](https://learn.chatgpt.com/docs/models)
- `serviceTier` 与 reasoning effort 分开。首轮使用标准速度；Fast / Ultrafast 若要提供，需消费 provider 的 serviceTiers、扩展共享配置并保存实际 tier。不能用 `max` 或 `ultra` 代替服务档位。GPT 6.2 不支持 Flex。[GPT 6.2 迁移说明](https://developers.openai.com/api/docs/guides/latest-model)
- `codex-backend.ts` 当前把每个模型的 `maxOutputTokens` 写成 `1_000_000`，应修复。6.2 的公开 API 最大输出为 `128_000`，不能混同输入窗口。容量优先使用可信的 provider 元数据，否则使用带来源的版本化 fallback；不把 API 总上下文窗口当作当前 Codex 会话的实际容量。
- 0.171.0 的 `turn/start` 没有逐回合 `max_output_tokens` 字段。保留现有“本地观察 usage 后停止后续效果”的降级说明，不宣称实现了远端硬输出上限。[TurnStartParams](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts)

### 3.3 价格、上下文和历史兼容

| 模型 | 标准短上下文输入 / 缓存读 / 30 分钟缓存写 / 输出，USD 每百万 token |
| --- | --- |
| `gpt-6.2-sol` | `2 / 0.1 / 2.5 / 10` |
| `gpt-6.2-astra` | `8 / 0.4 / 10 / 40` |

价格来自上述两个官方模型页。它们只适用于列明的基准条件：超过 272K 输入后的完整请求费率、缓存保留期及 Fast/Ultrafast 都会改变价格。当前 PricingEntryV1 只有每模型一组固定费率，不能完整描述这些维度。

需调整 `config/pricing/m12-pricing-catalog-v1.json`、`packages/agent-runtime/src/default-pricing.ts`、`pricing.ts`、`accounting.ts` 及 `g03-accounting.test.mjs`：

1. 计价目录增加版本与来源时间，保留旧模型行供历史记录解释。订阅模式的费用继续为 unknown，不能用 API 单价显示为订阅实际账单。
2. 推荐先在标准、短上下文且计费信息完整时估价；其他情况保留 unknown 和原因。若要支持全部费率，先由 studio-contracts 评审 request 级别的 tier、上下文长度、缓存保留期计价契约，再实现规则。
3. 长上下文阈值按单次请求判断，不能拿跨请求累计 turn usage 判断；缺失请求级证据时不得给出伪精确估算。reasoning token 不能在 output 已包含时重复计费。
4. 对旧 Session、Surface 和 Usage/Cost 记录只追加新的选择、迁移或诊断事实，不重写旧配置、价格版本和 operation log。

GPT 6.2 对历史前缀变化和模型切换的 reasoning/cache 行为已有调整。保持稳定的基础指令、工具排序和可重建上下文；验证切换模型及压缩后不拆开 tool-call / result 配对，不把本地 context cache 命中当作 provider cache 命中。当前通过 Codex App Server 调用，不应为照搬 Responses 示例而额外添加一条直接 HTTP 调用路径；若以后实现独立 OpenAI API backend，再单独应用 developer-message / instructions 布局迁移。

现有 GPT 产品主要是 Codex 登录流程。本轮先完成这一调用路径；新增独立的 OpenAI API-Key backend 应作为单独变更，通过现有 AgentBackend 接口接入，不把 GPT 模型 id 塞进只处理 DeepSeek 请求的 Harness adapter。

## 4. 可执行的变更拆分

| 变更 | 范围 | 验收后才能继续的条件 |
| --- | --- | --- |
| A：冻结基线与运行环境 | 保存当前 lock / candidates / 恢复样本，补齐 M06 contracts、integration 和活动 Goal；开发/CI Node 至少 24.9，检查 Electron Node | 安装和当前定向检查可运行，候选来源齐全；不改 milestone 状态 |
| B：Codex 与 GPT 6.2 | 0.171.0 协议、动态目录刷新/分页、精确 effort、容量修正、计价与 UI 测试 | 两个目标模型均有真实授权账号的调用证据；旧会话、取消和工具请求通过 |
| C：Engine 兼容集合 | Engine/extensions 0.2.3 + animation-spec 0.2.2，候选、文档索引、物理/渲染/脚本回归 | 新旧 Scene/文档往返、拾取、资源释放和真实 WebGPU 回归通过 |
| D：UI 与 Editor Shell | 先取得兼容的 shell 候选，再升级 UI 0.2.3 评审候选；已发布 0.2.2 可作为独立阶段 | 单份 UI，advanced-authoring 与所有现有交互回归通过 |
| E：Harness rc.5 | Cordis 4.1、AgentModel、executor/batch API、Session/Projection、实验 Team 与扩展工具 | 完整闭包与 bridge/session/process 定向检查通过，新存储写入前有回滚样本 |
| F：组合准入 | 两后端 × 编辑/Play/恢复/取消，重新绑定证据与能力 census | 定向检查及 `npm run check` 全部通过，满足活动 Goal 全部验证 |

这些变更可以顺序提交到同一升级分支；不要求一次提交同时替换所有运行时。B 不依赖 C/D/E；D 必须先解决 Editor Shell 的 UI 范围约束。

## 5. 验证矩阵与实施命令

按修改范围先运行对应 workspace 的 `npm test -w <workspace>`，再运行总检查。所有测试使用真实新构建产物，不能用旧 dist 或跳过脚本的安装结果冒充运行验收。

| 范围 | 定向验证 |
| --- | --- |
| M12 / GPT | contracts:check；agent-runtime、agent-backends、studio-shell 测试；增加 6.2 两模型/多页/刷新/账号切换/max/未知 effort/缺失价格 fixture；保留旧 5.6 fixture 验证兼容 |
| Codex 协议与效果边界 | 初始化、登录/登出、无权限、动态工具、问答、线程复用/冷恢复、turn interrupt、进程退出、迟到 usage；所有内建文件/命令/网络效果仍由 adapter 阻断 |
| Engine | editor-plugins / script-preview 测试；`g07-physics-runtime.test.mjs`、`g08-render-effects-runtime.test.mjs`、`pointer-placement-electron.test.mjs`；真实 GPU 下 Play start/stop/restart、拾取、像素、模型/纹理/动画/音频与资源清理 |
| UI / Editor | workspace、split-layout、electron-smoke、资源面板窄宽度、展开/焦点/键盘/主题；`editor:candidate:check -- --milestone-file <真实绝对路径>`，不能伪造缺失的 M03 证据 |
| Harness | bridge 全套，重点 harness-upgrade、official-tools、request-context、session-v4、team-recovery、read-concurrency；extended-web/node/browser smoke 与持久化恢复/进程矩阵 |
| 工程准入 | upstream:check、engine:candidate:check、render:candidate:check、boundaries:check、spike:check、engine:docs:check；实际重采集 M14 evidence/census 后再 check；补充独立 UI candidate/hash/export 校验并纳入总检查 |
| 真实任务 | 使用已有 smoke:codex / smoke:deepseek 机制及授权账号，在 Electron 证明模型选择与实际调用一致、工具能修改 Document 并撤销、停止后不再写入、重启后可恢复；记录脱敏配置与 usage，不导出凭据 |

典型执行顺序：

```powershell
npm ci
npm run contracts:check
npm test -w @haiyue/ai-studio-agent-runtime
npm test -w @haiyue/ai-studio-agent-backends
npm test -w @haiyue/ai-studio-harness-bridge
npm test -w @haiyue/ai-studio-editor-plugins
npm test -w @haiyue/ai-studio-script-preview
npm test -w @haiyue/ai-studio-shell
npm run check
```

上面是实施阶段的基础顺序，仍须加入矩阵中对应的 Electron、真实 provider 和 Goal 检查。`npm run check` 当前没有包含所有 Harness/backend workspace 测试，也没有自动完成真实模型调用，单独一个总检查不能替代这些验收。

## 6. 回滚与本次验证边界

每组变更保存完整 manifests、lockfile、tarballs、candidate 配置和生成协议/文档，而非只回退顶层版本。升级安装时确认 Engine、UI、Cordis 的单实例及全部 peers，不能混用新旧 dist。

Harness 新 Subagent catalog 载荷会使旧版本无法读取升级后写入的 Session。试迁移应使用隔离样本，升级前备份；若要回滚运行时，恢复升级前的数据快照并保留升级后日志供审计，不能原地改写新日志为旧格式。Document History、Studio durable Session 与上游 Session 持久化分别核验。

本次已完成：上游发布和 npm 元数据核对、10 个包的官方 integrity 校验、目标公开导入面比较、Engine 拾取补丁分支检查、UI/Editor 依赖约束检查，以及 Harness/GPT 代码路径审计。

本工作区没有 `node_modules`。已按顺序尝试定向 `npm run boundaries:check` 和总检查 `npm run check`：前者因缺少 `typescript` 无法启动，后者在 contracts:check 因缺少 `ajv` 退出，后续检查未运行。本次未安装生产依赖，未进行构建、GPU、真实模型调用或存储迁移验收，不能将上述静态审计记作升级已通过。

当前工作区中未找到要求实施前阅读的 M06 `contracts.md`、`integration.md` 和活动 Goal 原始文件；现有 contract-index、M12/M13 架构文档及 nested AGENTS 已作为本方案依据。正式修改包前需补齐这组原始约束；本次仅写方案和审计记录。
