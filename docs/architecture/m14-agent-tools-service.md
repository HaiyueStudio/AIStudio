# G04 行为工具与 G05 接线

G04 在现有工具注册表增加 `behavior.query`、`behavior.locate`、`behavior.explain`（版本均为 `1.0.0`），消费 G02 的 `BehaviorReadService`。工具可经原有 `tool.search → studio.tool.invoke` 调用；没有新增 MCP 服务、Document 写入器、History、项目任务状态机或模型提示词。

## 调用与数据边界

1. `project.snapshot` 获取当前修订；`tool.search` 使用 `includeSchemas: true` 返回目标版本、输入规则、风险与实际调用入口。
2. 首次 `behavior.query` 必须提交 `baseRevision`；可按 `entityId`、节点 `kind` 过滤。`offset` 默认 0、`limit` 默认 25，单页最多 100 个节点。
3. 返回结构页、页内边、事件入口、完整 `binding`、`manifestDigest`、分析器与配置摘要，以及分析截断状态。后续页同时提交原 `manifestDigest` 和 `binding.digest`（参数名 `sourceBindingDigest`），以返回的 `nextOffset` 继续；参数规则与实际验证均拒绝缺失或只提交一个摘要的续页请求。
4. `behavior.locate` 接收上述绑定和一个 `nodeId`，返回 G02 的 `EditorLocationV1`。`behavior.explain` 接收绑定、1–100 个不同的 `nodeIds` 及 `en` / `zh-CN`，返回独立的 `BehaviorExplanationV1`。两者都附完整来源绑定。

定位可以指向脚本范围、组件字段或已准入的适配器说明。解释使用 G02 的确定性结构模板，保留 `verified-structure` producer、依据引用及独立 digest；它不证明运行发生，也不创建 Play trace。语言变化不修改结构图。

三个工具均为 registry-owned `observe / low`，依赖现有 `studio.script-preview` 服务能力，无修改审批。它们暂不宣告可并发，继续由现有调度器串行保护。单次执行预算为 20 秒、64 KiB。查询在必要时缩小页大小，返回真实下一偏移及 `pageTruncated`；不能在预算内返回完整绑定和一个节点时明确失败，定位/解释超限也失败，不返回脱离来源的局部结果。

## 生命周期与当前项目

`GameAuthoringToolRuntimeOptions` 与插件选项增加可选的 `behaviorSource: GameBehaviorSource`。其签名为 `(signal: AbortSignal) => unknown | Promise<unknown>`，返回当前权威 `BehaviorAnalysisInputV1`；边界按 G02 schema 重新验证。模型参数不能提供项目快照、registry、adapter、分析配置或风险信息。

输入中的 projectId、documentId 和 documentRevision 必须与实际 ProjectWorkspace 一致。分析前检查调用修订及预期来源摘要；分析完成并释放 Worker 后再次读取来源，核对完整绑定和配置，交付前再核对当前文档。组件、脚本、资源依赖、registry 或 adapter 变化均可使旧结果失效。旧节点/位置不会被当作当前来源。

每次调用拥有独立 G02 reader；完成、失败、超时、取消和插件销毁均释放它。迟到的来源回调无法继续分析或产生成功记录；来源回调应主动响应 AbortSignal。重复销毁等待同一清理过程。外部回调异常与无效来源不回显原始异常内容，现有 durable tool 日志继续承担调用关联、时长和结果记录。

## G05 交接

当前产品装配尚未注入 `behaviorSource`；没有来源时行为工具明确返回 `behavior.unavailable`。本次验证使用真实 ProjectWorkspace、G02 Worker 和工具运行器，注入的 registry/adapter 元数据属于已检查的测试 fixture，不能视作产品准入版本。

G05 在 `agent-orchestration` 实现项目生命周期与行为流程，向插件注入当前项目文档、权威组件 registry 版本/定义、已准入 runtime adapter 版本/摘要和分析配置。不得用常量伪造产品版本或依赖摘要。项目切换/关闭需中止前一项目任务；派生结构、解释和 trace 按原计划复用 operation-log 与项目记录。应用层只装配服务与 IPC；renderer 消费有界投影。运行观测、项目归档、逻辑面板与统一位置跳转仍由 G05 接通。

G06 的完整资源目录不影响现有工具：文件资产走 `asset.search/import/assign/dependencies`，创建走 `entity.create` 等既有路径，组件值走 `component.configure`，场景实例走查询/定位/编辑。未具备持久化准入的 template/preset 不伪装为可用目录项，非资产 ID 不接受 `asset.assign`。批量修改继续复用 `SceneTransactionCoordinator`，没有新增 `scene.transaction` 工具或执行器。

实现：[工具适配](../../packages/game-authoring-tools/src/behavior.ts)、[注册表](../../packages/game-authoring-tools/src/definitions.ts)、[插件接线端口](../../packages/game-authoring-tools/src/plugin.ts)。验证与限制见 [G04 验收记录](./m14-agent-tools-acceptance.md)。
