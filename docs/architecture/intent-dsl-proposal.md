# 统一意图 DSL 与下一轮 Agent 优化方案

状态：设计草案 0.1，2026-09-16。本文和同目录样例未接入生产运行时，未更改工具权限、审批、调度或预算算法。建议作为新的 W8 工作范围；不代表已经完成 W8 实现。首版覆盖“用户需求 → 可验证意图”，玩法语言另作后续扩展。

## 1. 当前缺口与结论

已有协议不需要推倒重建。缺少的是一份具有来源、否定语义、对象指代和验收要求的规范化意图，用来连接这些协议。

| 现有层 | 代码位置 | 已具备 / 缺口 |
| --- | --- | --- |
| UI 命令 | `packages/studio-shell/src/conversation/types.ts`，`ConversationIntent` | 表达提交、取消等 UI 操作，不是用户需求语义。 |
| 工具路由 | `packages/game-authoring-tools/src/catalog/runtime.ts`，`selectDefinitions` | 固定核心工具 + 正则 + 混合排序；不识别否定、纯解释与修改的区别。 |
| 上下文路由 | `packages/agent-runtime/src/prompt-context.ts`，`retrievePlaybooks` / `prepare` | 独立关键词匹配；没有与工具选择共享的规范化意图。 |
| 计划与批次 | `studio-contracts/src/workflow.ts`、`agent-orchestration/src/plan-policy.ts` | 已有 `PlanTaskV1`、`ToolBatchInputV1`，应继续负责执行。 |
| 验收 | `plan-assertion.ts`、`task-acceptance.ts`、`game-authoring-tools/src/observations.ts` | 已支持结构化断言和 evidence 字符串；需求、约束与断言之间缺少可追溯映射。 |
| 行为结构 | `studio-contracts/src/m14.ts`，BehaviorManifest | 表达实际代码/行为及其来源，不能当作“用户希望怎样”的意图模型。 |

`taskSpecFromPlan` / `taskSpecFromRun` 目前将 `visibleConstraints` 设为空数组。原始目标仍在 `request` 中，不能说约束已完全丢失；但下游无法可靠地区分“必须做、不能做、保持不变”，恢复也依赖摘要。统一 DSL 应补上这一层。

## 2. 数据流与责任边界

```mermaid
flowchart LR
  A[原始消息与提交时快照] --> B[IntentProposal JSON]
  B --> C[Host 校验、对象绑定与影响分析]
  C --> D[已有 TaskSpec 与 PlanTask]
  D --> E[已有工具或 ToolBatch]
  E --> F[已有验收与证据]
  C --> G[按目标选取工具和上下文]
  G --> D
```

采用 **JSON AST + JSON Schema + Host 语义校验**。首版不再引入一套自由文本语法解析器。人类可读的展示由 AST 渲染，原始用户消息始终保留引用。

三层分别负责：

1. **IntentProposal：模型提出的需求解释。** 包含 goals、targets、requirements；是待验证数据，不能自行声明 ready、approved、effect、parallel、预算或权限。
2. **Host 绑定记录：系统确认的解释。** 保存消息摘要指纹、提交时 selection、Document revision、精确 entity/component/material 引用、property registry 版本、冲突/歧义和需求到验收的映射。这些来自已有可信状态，不能由模型伪造。绑定记录随现有 CAS/Operation Log 保存，不建立第二套事实仓库。
3. **执行协议：沿用现有所有者。** 编译到 `TaskSpecV2`、批准后的 `PlanTaskV1`、`ToolBatchInputV1` 和 evidence 断言。Usage、Cost、Budget 等 M12 公共类型仍只归 `m12.ts` / contract index 所有。

建议正式接入时在 `studio-contracts` 增加独立意图合同及索引，不复制 TaskSpec/Usage/Cost。DSL version 与协议 schemaVersion 分开管理；未知版本拒绝执行并保留原请求，不能静默降级丢掉约束。

## 3. 首版字段与语义

完整形状见 [Schema](intent-dsl/intent-proposal.schema.json)。这是设计目录中的草案，不是已注册产品合同。

| 字段 | 含义 | 重要规则 |
| --- | --- | --- |
| `version` | `intent/0.1` | 精确版本，不容许未知字段。 |
| `goals[]` | action、domain、targetRefs、requirementRefs、dependsOn | 语义目标 DAG，不等于可并行执行 DAG。所有目标必须关联要求。 |
| `targets[]` | selection / name / fact / complement / unresolved | selection 绑定消息提交时快照；name 必须验证唯一性；fact 只能引用 Host 已提供事实。 |
| `requirements[]` | id、source、predicate | 每条要求都有来源，必须被目标引用；一条要求可约束多个目标。 |
| `source` | messageRef + UTF-16 `[start,end)` | Host 核对不可变消息，禁止越界、切断 surrogate pair；范围合法不代表语义正确。 |
| `predicate` | compare / prohibit / preserve / answer / observe / unresolved | 所有要求都必须处理，不能静默当作可选项丢弃。 |

`compare` 表达属性比较，`prohibit` 表达禁止的操作及作用范围，`preserve` 表达相对提交快照保持不变。`answer` / `observe` 保存解释与读取要求，Host 再绑定可用来源；`unresolved` 保存无法规范化的要求，阻止依赖它的修改进入执行。

每项 requirement 最终必须映射到以下之一：可执行的前置守卫、现有自动验收、明确的人工验收、未支持/待澄清阻塞。不能把“更好看”随意编成一个数值阈值，也不能仅凭自然语言文本存在就视为已验收。answer/observe 的文本同样不能直接冒充机器可执行断言。

首版逻辑属性如 `appearance.color` 是**拟议词汇**，不是当前工具或 evaluator 已支持的路径。需要版本化 registry 映射到实际对象类型、组件路径、工具 schema、单位/色彩空间和可用证据。对不支持的绑定明确返回 unsupported；不能拼出貌似合法的 `evidence ...` 字符串后执行。数值比较的类型、单位、容差由属性定义决定。

来源与意图之间仍可能出现模型解释错误。Host 要做矛盾、需求覆盖与领域类型检查；规则无法判定的歧义交给已有澄清/计划审阅路径。Schema 校验不是自然语言理解的正确性证明。

### 示例

输入：“把选中的按钮改成 #FF0000，保持其他对象不变。不要创建实体。”

解析为一个 `modify/appearance` 目标，三个要求：

```text
req:color      compare(target:button, appearance.color, eq, #FF0000)
req:preserve   preserve(target:others, request-snapshot, authored-state)
req:no-create  prohibit(create, document.entities)
```

这里的文本只是 AST 展示，不是第二种解析格式。可运行以下命令查看包含全部来源范围的 JSON：

```sh
node docs/architecture/intent-dsl/validate-examples.mjs --example
```

Host 处理时先解析按钮实际类型。几何实体可能适用 `material.set`，UI 控件可能需要对应组件接口，不能仅凭“按钮”直接选择材质工具。如果共享材质会影响其他对象，必须纳入影响分析；只比较直接修改的 entity ID 不足以证明其他对象未变。

`preserve authored-state` 应比较既有 Document 可编辑内容和引用依赖，排除运行时计时器等瞬时状态。它不自动保证视觉完全相同；用户明确要求外观或行为不变时，需要另列对应证据或人工验收。`complement` 的集合基于提交时 document.entities；“不准创建实体”单独约束新增对象，不能用旧集合的补集检查代替。

### 校验顺序与错误处理

1. 限制编码字节数、数组规模和字符串长度；使用既有敏感信息入口过滤。未知字段拒绝，允许字段内的秘密也必须脱敏；样例只验证额外 credential 字段，不能替代产品脱敏器。
2. 校验 Schema、全局唯一 ID、引用闭合、目标/选择器无环、来源存在且范围合法。
3. 检查互斥要求、否定、单位和领域类型；解析唯一对象、事实版本、selection 及 revision。空选择或同名多个目标不能默认全选。
4. 构造真实影响范围、前置条件与验收覆盖表，检查支持能力。无法确认的对象不能形成写计划。
5. 沿用原有计划/prepare/approval/commit 与 revision 检查。小任务也不能通过 DSL 绕过原策略。

一次失败返回有界诊断：`code + path + sourceRef + allowedValues/expectedType`，最多一次自动格式修复。修复仍失败时使用已有澄清/失败回执；不能反复搜索工具、重建整个计划。超大需求按来源拆分，保持完整覆盖，不截断 JSON 或最后几项约束。

## 4. 如何减少 token 和流程等待

**避免新增固定的意图识别轮次。** 明确的结构化 UI 命令由本地生成提案；复杂自然语言可在首次计划响应中附带提案，由 Host 在同一接收阶段校验、绑定，再进入原有执行流程。正式合同可扩展原 plan proposal 输入，但目前尚未实现。规则只处理确定情形，不能用新的关键词表伪装可靠语义解析。

首轮模型尚未返回 AST 时，复杂请求不能提前依赖完整语义选择工具。可先用保守的领域候选集与原文，收到提案后在安全边界更新工具 manifest。无需计划的直接调用若仍需模型消歧，可能多一次交互，必须计入 TTFT/总延迟，不能宣称所有请求都省一轮。

**一次规范化，多处消费。** 工具路由、playbook 检索、计划约束和验收统一消费同一份绑定意图，避免各自猜测。纯解释使用回答/按需资料读取集合；纯查询使用观察集合；修改按实际组件能力加载精确 schema。没有验收需求的解释任务，不应默认挂接预览、截图和运行回归。

**上下文按任务投影。** 保存完整源请求和 AST 的不可变 artifact；父 Agent 接收紧凑目标、全局禁止项、当前目标约束、已绑定事实及证据引用。子任务只接收其目标及所需事实，同时继承相关全局禁止项。不能只给引用而不给模型完成当前工作所需内容，也不能每轮重复整份 JSON、原文、计划与快照。

稳定策略/工具定义置于稳定前缀；事实、结果、当前步骤放动态部分。按需读取有界 artifact，基于 digest 去重；缺失或过期时重新获取精确事实。摘要不能取代硬约束。分别记录 prompt bytes、provider input/cache tokens、读取次数；本地缓存命中不等同于 provider token 缓存命中。

意图更新采用 Host 持有的不可变版本与 supersedes 引用，模型不能自行覆盖历史。新要求与旧要求的冲突由 Host/用户明确解决；selection、revision、工具版本或约束变化会使相关绑定失效。恢复从 retained intent/source artifact 重建，不从截短 requestSummary 猜测。manifest 只在已有安全边界切换并重新绑定签名，保持 W1 的稳定性。

## 5. 并行判断如何落地

`goals.dependsOn` 只提供语义依赖。Host 仍需通过注册工具元数据、实际参数、对象引用和 revision 计算读写冲突，并复用 W6 调度器。

| 工作 | 决策 |
| --- | --- |
| 同一快照上的独立查询、互不依赖的本地上下文准备 | 可在有界并发下执行，统一取消并等待真实退出。 |
| 创建实体后设置其未知 ID 的材质 | 必须有先后依赖；W6 当前 literal arguments 不支持未知输出替换，应分批。 |
| 修改不同对象但共享材质、父层级或全局设置 | 不能仅凭 ID 不同并行，需计算实际影响。 |
| 审批、revision 切换、事务提交与运行时屏障 | 保留现有屏障。 |
| 两个独立的大型候选生成任务 | W7 可成为执行选项，但需预算正确、隔离成立且真实 A/B 收益通过准入。 |

先利用确定的本地/工具并发，再考虑多模型子任务。收益判断应基于 `串行关键路径 − 并行关键路径 − 准备/合并开销`，同时比较质量、总 token 和总成本；模型估时只能初筛。没有实测证据时维持 W7 默认关闭。

## 6. 额外优化发现及优先级

本轮本地复现见 [结果](intent-dsl/current-findings.json) / [脚本](intent-dsl/probe-current.mjs)。脚本使用现有 dist，记录关键源码/产物 hashes，不发模型请求；hash 只标识版本，不证明构建对应关系。catalog 使用空 component 集合，数字是工具 schema UTF-8 字节，不是 token 或完整 HTTP 请求大小。

| 优先级 | 证据 / 影响 | 修复方案与验收 |
| --- | --- | --- |
| P0 | **预留重复占额，已复现。** cap=200，两个子任务各预留100；其中一个已上报50，仍保留200，于是下一 turn projected=250 并锁定 hard stop。`accounting.ts:preflightReserved`。 | lease 显式绑定 child/request/turn，计算已用 + 尚未上报的剩余承诺 + 新分配。已消费50后剩余预留应为150，投影200；分 metric 处理 token/成本，未知消耗继续保守保留。验证乱序、重复 usage、超额与取消。 |
| P0 | **并发 wall time 累加，已复现。** 父+两个子 turn 均覆盖0–100ms，aggregateUsage 返回300ms。可作为累计工作时间，却不能直接作为任务已过时间。 | 分开记录工作耗时与任务 active elapsed；定义真实任务计时边界、排除人工等待，正确处理重叠区间。不能仅把 ledger sum 改成 max，串行和工具等待也要覆盖。若改公共字段，走 M12 所有者迁移。 |
| P0 | **已知计费失败子任务仍可能保留全额预留，静态链路确认。** `subtask-runtime-port.ts` 无候选时抛错，finally reconcile；`subtasks.ts` 仅成功返回时 settleWork。 | 将“账本结算”和“候选有效性”分开。生命周期必须返回/保留精确 turn 身份与 dispatch 状态；已知最终消费结清，不确定消费继续保留，不能无条件 finally 退款。补非结构化最终输出场景。 |
| P1 | **否定/只读工具路由失真，已复现。** “不要创建…只检查…”选20工具/27248字节且含 entity.create；“解释相机”选20工具/24569字节且含 camera.set、script.apply。 | 意图驱动的操作/领域过滤，禁止项参与选择；精简场景化 core，保留有界发现兜底。工具被选中不等于已经越权执行，原 effect policy 仍在。 |
| P1 | **改色路由漏掉相关工具，已复现。** “把选中的按钮改成红色…”选20工具/29664字节，含 entity.create、play.regression，无 material.set。 | 先绑定按钮类型再选确切工具，补 appearance/color/UI 领域映射。按实际类型评估命中率，不能要求所有按钮都调用 material.set。记录后续发现调用数与首个有效工具时间。 |
| P1 | **约束未进入结构化 TaskSpec，静态确认。** 两个 taskSpec 构造函数 visibleConstraints=[]。 | 从 DSL 编译可见约束和对应前置守卫/验收；验证否定、preserve、恢复和用户补充要求。 |
| P1 | **断言解释分散，静态确认。** plan-assertion、verificationRoute、observations 各自处理表达。 | 单一规范化断言 AST/信号目录，兼容现有 evidence 文本入口；计划校验、验证工具选择、evaluator 共享语义，防止一个能通过另一个不能执行。 |
| P1 | **启动准备存在串行段，静态确认。** Host 工具选择→project→prepareKnowledge→context.prepare；prepare 又先等待 retrieval。 | 捕获同一快照后并行独立只读准备；依赖知识索引刷新的 retrieval 保持依赖。使用现有 scope/AbortSignal，有界检索失败保留明确状态，必需事实不可直接跳过。实测 critical path / TTFT，不能仅比较函数耗时之和。 |
| P1 | **W7 准入缺少内建报告验证器。** qualify 为可信注入回调，当前仅检查引用存在，不代表生产组合层已验证真实收益。 | 增加真实报告加载与校验，绑定 backend/model/profile/registry/revision/任务组；计入父审阅合并，质量不退化后比较 latency/token/cost。沿用默认关闭。 |
| P2 | **catalog 每次重算候选 embedding、schema bytes，静态确认。** | 按 registry version + schema digest 预计算候选向量和字节数；组件热更新时精确失效。先测本地 CPU，不声称能省 provider token。 |
| P2 | **usage 事件触发全任务扫描/重新计价，静态确认。** bindTurn→reconcile→taskLedgers / snapshot。 | 按 turn/event 增量更新与缓存价格结果；保持累计事件、迟到修正和 unknown 语义，做长任务事件量基准。 |

这些发现不表示 W1–W7 都无效；它们说明需要补端到端语义和并发预算边界，才能稳定兑现已有机制的收益。

## 7. 建议实施顺序与验收

| 阶段 | 工作 / 主要所有者 | 完成标准 |
| --- | --- | --- |
| W8-A | 先修三个 P0；agent-runtime / orchestration | 最小复现转回归；known/unknown/失败/取消账本一致；并发/串行时间统计准确。 |
| W8-B | 正式合同、registry、Host binder；studio-contracts / orchestration | 合法/非法/未知版本/秘密字段合同夹具；来源、否定、指代、约束覆盖、陈旧 revision 可诊断；原任务链兼容。 |
| W8-C | 影子解析与领域路由；catalog / prompt-context | 先记录意图与现有决策差异，不影响生产执行；有真值标注的中文/英文需求集，包含否定、混合目标、同名、多轮修订、模糊指代。 |
| W8-D | 在小范围消费 DSL；TaskSpec、工具和上下文 | 首轮不强制加一次模型请求；相同任务能完成，约束不丢失，工具发现与重复观察减少；失败可回退到原流程且原文/硬约束保留。 |
| W8-E | 上下文准备并行、catalog 缓存、报告准入 | 测本地关键路径；真实模型配对 A/B 通过才按任务类别启用 W7。 |

度量应包含：意图/否定/目标绑定准确率、unsupported 与 clarification 比例、需求验收覆盖率、总/无效工具调用、发现重试、prompt bytes、provider 输入/缓存/输出 token、父子合计成本、TTFT、端到端 median/p95、预算误拒率。正确性是准入门槛，不能只追求 schema 更短。

可先以现有方案要求的每任务组至少5次配对试验做探索，固定模型配置、初始项目和 warm/cold 条件并保留失败样本；5次不足以稳定判断 p95，正式启用需要扩大样本并报告分布/不确定性。任何节省百分比均应来自真实 provider 结果，目前没有这样的结论。

后续如需玩法 DSL，可另定义领域层表达事件/状态/条件/动作，再通过允许的组件/脚本工具编译，并与 M14 实际行为图核对。不要把意图图直接发布为“实际已经运行的行为图”。

## 8. 本轮交付与验证边界

```sh
node docs/architecture/intent-dsl/validate-examples.mjs
node docs/architecture/intent-dsl/probe-current.mjs
```

本轮草案校验21项通过；本地探针复现上述工具选择和两项预算统计问题。例子检查只覆盖形状和部分语义，不含真正的对象绑定、完整矛盾求解、脱敏或执行。所有新增文件位于设计文档目录，没有改生产源码或启用 W7。

完整仓库状态沿用 [W7 验证记录](agent-efficiency-w7.md)：定向58/58、能力344/344；全量集成394通过、6失败。本轮未重新运行完整集成，也不把文档校验视为修复了这些失败。实施 W8 时需要完成受影响回归和仓库要求的检查，不推进尚未完成的里程碑。
