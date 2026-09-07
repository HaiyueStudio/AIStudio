# M14 G04 独立验收记录

日期：2026-09-07。范围是复用通用工具并接通行为查询、定位、解释的服务与双后端调用链。用户显式启动 G04；直接前置 G02 已完成。M12 G12 blocked、M13 G11 active 和后续 Goal 的门禁保持。

当前状态：G04 独立验收完成。验收输入绑定为 `sha256:77a28878cbf2bb2b2767ce20436a022c5ff71b79f7fedcc046da54b4a6c7568b`，来自 [能力验证记录](../../config/contracts/m14-capability-verification.json)。

## 逐项证据

| 要求 | 当前实现与验证 |
| --- | --- |
| 相同注册表和搜索到实际执行 | `behavior-tool-invocation.test.mjs` 分别使用生产 HarnessApiKeyBackend、CodexAppServerBackend、StudioConversationHost、GameAuthoringToolRuntime、ProjectWorkspace 和 G02 Worker。通过真实选择器的 core-only 预算省略三项行为工具，再在同一次 provider turn 中搜索并从返回的 `studio.tool.invoke` 入口实际调用 |
| 目标版本与 schema | 未知/递归工具、未知版本、模型伪造风险、错误输入均拒绝；行为 schema fuzz 同时验证公布的 JSON Schema 和 prepare 边界，包括 null、整数范围、摘要成对约束、续页绑定、重复 node IDs、未知字段和越权来源输入 |
| 项目与多来源绑定 | `behavior-tools.test.mjs` 从真实脚本 proposal/apply 与组件配置生成纯脚本、无脚本的纯声明式、混合项目。查询返回真实项目和完整 manifest 绑定，定位经独立 G02 reader resolve 为 current；读前后文档、History 不变 |
| 独立解释 | 中英解释按 G02 合同解析，producer 为 verified-structure，依据等于节点来源，语言产生独立解释摘要；保留静态结构与运行证据边界，不启动 Play |
| 修订、来源与配置失效 | prepare 后修改组件、旧摘要搭配新修订、跨项目/文档、registry/adapter/config 变化、读取期间来源漂移均拒绝；重新 query 返回新的绑定与结构摘要 |
| 计划、审批、风险与重放 | 双后端组合测试先拒绝未批准计划的修改，再批准计划；entity.rename 在实际修改审批前保持文档不变。timer 的低风险策略由组件 registry 推导。修改后旧定位失效；原 provider callId、目标 toolId、invokedVia、成功日志及对话投影保留，重复 replay 不重做修改 |
| 有界结果、取消与脱敏 | 长路径/多节点分页小于 64 KiB，缩页后连续且页内边无悬空引用；超时、主动取消、重复销毁无迟到成功。缺少来源仍可调用原工具；非法来源、带 secret 的回调异常及伪造协议异常不泄漏到结果或日志 |
| 现有组件/资源与四种 kind | 原 runtime 回归实际执行受控文件资产导入、搜索、分配、依赖、Undo/Redo 和重开。新增资源组合测试拒绝 template/preset/instance ID 转交 asset.assign，通过既有创建、组件描述/读取/配置和 Undo/Redo 修改灯光，未注入行为服务或目录 UI 仍可完成 |
| 单一事务与回滚 | 原 transactions 测试覆盖 7 / 100 成员单 History entry、并发 prepare、stale、无重复提交、写入失败和无局部状态；runtime 测试覆盖原组件、资产、脚本、Play、task/diagnostics 与取消。注册表没有第二个 scene.transaction |
| 七类游戏与提示词 | 既有 g08-seven-game-semantic-cases 保留七类组合，新增三项工具不包含游戏种类分支或提示词；既有 eval isolation 扫描生产源码并检查固定请求/隐藏 oracle 的隔离。此项为通用表面与隔离回归，不宣称七类游戏的真实模型运行验收 |

## 可复验入口

- `npm run m14:agent-tools:check`：构建当前工作区后运行全部工具测试、`test/agent-tools` 目录和旧搜索调用测试；避免顶层测试匹配漏掉新增目录。
- `npm run m14:agent-tools:test`：构建产物已就绪时执行同一测试集合。
- `npm run m14:capability:capture`：从当前输入重新构建、执行验证并生成 census；行为测试与双后端服务链已加入 tools 证据组。
- AIStudio `npm run check`：包括新增工具回归、既有合同/类型/边界/上游/候选包、七类 quick gate、G02 和真实窗口回归。
- milestones `npm run check`：验证执行规划、状态及引用。

## 验收边界

最终检查结果：

- AIStudio `npm run check` 全部通过：53 schemas、53 valid / 82 invalid fixtures；类型与边界、上游/候选包及协议检查通过；58 项既有 quick gate、24 项 G02 回归、5 项工作区/真实 Electron 验证、99 项工具与双后端回归，均无失败、取消或跳过。
- 能力重新采集完成：当前完整构建通过，9 组、89 项检查通过；35 capabilities / 44 components / 50 tools，product-integrated 仍为 0。tools 组包含新增多来源、资源组合和两个后端的真实服务调用。
- milestones `npm run check` 通过；9 个 Goal、14 条直接依赖全部按编号向后执行。G01/G02/G03 历史完成记录保留，G05–G09 仍为 draft。
- 无在线模型调用、发布、提交或推送；前序暂存修改保留，本次实现及验收文件留在工作区供审查。

双后端测试的 provider transport 是确定性替身，后端适配器及其下游服务是真实生产实现。它验证搜索到真实编辑器调用与审批/记录，不替代 DeepSeek/Codex 在线模型或七类游戏的正式冷启动验收。M12/M13 历史证据、G01/G02/G03 已完成记录不重写，product-integrated 不因此提升。

当前产品仍待 G05 注入权威 behaviorSource、接通逻辑视图、项目派生记录与 Play trace。G04 不拥有该项目工作流，不新增 Engine adapter，不等待 G06/G08。接口与接线清单见 [服务说明](./m14-agent-tools-service.md)。

测试：[多来源与边界](../../packages/game-authoring-tools/test/behavior-tools.test.mjs)、[资源组合](../../packages/game-authoring-tools/test/behavior-resource-tool-invocation.test.mjs)、[双后端真实服务调用](../../apps/ai-studio/test/agent-tools/behavior-tool-invocation.test.mjs)、[通用 runtime](../../packages/game-authoring-tools/test/runtime.test.mjs)、[事务](../../packages/game-authoring-tools/test/transactions.test.mjs)。
