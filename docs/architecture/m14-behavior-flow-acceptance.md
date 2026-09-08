# M14 G05 独立验收

日期：2026-09-08。状态：G05 独立验收完成。用户显式启动 G05，直接前置 G03/G04 已完成。M12 G12 blocked、M13 G11 active 与 G06–G09 的后续门禁保持。

验收输入绑定为 `sha256:d15f599462875617a18f809df9293e5b17de8f8646b7b6a5c833a4a8dbb88b03`，与 [能力验证记录](../../config/contracts/m14-capability-verification.json) 及本次归档一致。实现边界见 [工作流说明](./m14-behavior-flow-implementation.md)。

## 产品结果

选择实体后，点击“加载结构”可查看脚本、声明式组件和适配器来源；结构图支持事件分组、来源搜索、折叠、缩放和分页。“解释此节点”独立加载文字说明，“回到来源”打开精确脚本范围或实际组件配置。运行时通过“行为与轨迹”读取该次 Play 的观测，停止时自动保存到现有项目记录目录 `.aistudio/agent/`。

结构、解释、轨迹分别存储。静态结构、已观测节点、未知部分明确区分；一次运行未覆盖某节点，不会删除它或将其判为不可达。物理事件保留真实实体归属，不伪造内部脚本路径。

## 验证对应

| 要求 | 验证依据 |
| --- | --- |
| 结构、解释和真实运行分别加载 | `logic-product-electron.test.mjs` 启动真实生产 main/preload/renderer 和 WebGPU Play，检查解释 DOM、真实观察事件及项目记录；整个流程在真实 reload 后重复 |
| 脚本 / 组件字段 / adapter 定位 | 产品窗口检查脚本内容摘要、选中范围及焦点；组件显示实际配置；adapter 显示注册身份及未知内部路径。`logic-behavior-ipc` 验证计时器的配置位置 |
| 搜索、分组、显式并发、缩放、折叠、键盘、窄屏 | `logic-panel-electron` 消费 G02 真正分析的结构与实际执行的 trace，检查有依据的并发边、分页、语言切换、原生弹窗焦点和 375 像素布局；布局位置不表示并行 |
| 纯脚本 / 纯声明式 / 混合来源 | 产品脚本 Play；`logic-declarative-play` 与 `logic-behavior-ipc` 用实际授权、公开 Engine 编译器和生产声明式运行器验证无脚本计时器、规则完成、状态变化及混合执行 |
| 同一结构的不同 Play、tick/replay、Stop/restart | `behavior-project` 验证新 Play ID/代次、不同分支及旧 Stop 不能覆盖新 Play；`logic-replay` 使用真实固定步长时钟验证输入在 tick 2/3 触发相应分支，并检查旧时钟关闭后的晚到执行不再写记录 |
| 项目切换、取消、版本失效 | 控制器测试覆盖文档修订、配置改变、取消与迟到结果、保存非结构元数据；旧 source range 被服务拒绝。面板测试检查切换项目后旧记录消失 |
| 现有事务和 evidence | `behavior/related` 根据当前有效节点来源查询项目日志，保留真实事件 ID、事务关联及 artifactRefs；IPC 测试验证实际写入的事务事实可被读回，并拒绝任意项目注入 |
| 项目内保存与移植，不改 Document/History | `behavior-history` 通过原 ProjectAgentHistory 复制索引和全部 artifact 分片，以全新的本机日志重读项目；控制器与 IPC 测试对比操作前后 Document 和 History |
| 预算与运行语义 | `behavior-runtime` 覆盖接收者、短路、赋值、异常、异步恢复、重复 finally、重入时长、原审批编译文本匹配、时间倒退、伪造归属、截断和脱敏 |

## 七类游戏

`logic-m12-fixtures.json` 固定保留原 M12 执行产出的项目文档，记录原路径和 SHA-256。测试在当前 registry 上分析，每个脚本节点均返回当前来源范围，且完整输入没有改变。以下数字是这组固定项目的结构规模，不是游戏完成度。

| 类型 | 节点 | 边 | 可插桩节点 |
| --- | ---: | ---: | ---: |
| 贪吃蛇 | 364 | 392 | 176 |
| 三消 | 560 | 599 | 317 |
| 俄罗斯方块 | 673 | 696 | 303 |
| 拼图 | 319 | 266 | 130 |
| 平台跳跃 | 350 | 386 | 183 |
| 赛车 | 452 | 437 | 195 |
| 射击 | 474 | 465 | 213 |

## 复验与归档

- `npm run m14:capability:capture`：从当前输入重新构建并运行能力验证，刷新 census 与输入摘要。
- `npm run m14:logic:test`：在构建产物就绪后验证项目工作流、七类来源、面板窗口、真实产品、replay 和项目持久化。
- AIStudio `npm run check`：包括合同、类型、架构边界、上游与候选包、既有 quick gate，以及 G02–G05 的回归。
- milestones `npm run check`：核对执行规划、前置状态和引用。

归档保留真实窗口截取的 [结构](./m14-behavior-flow-evidence/product-structure.png)、[脚本定位](./m14-behavior-flow-evidence/product-source.png)、[组件配置](./m14-behavior-flow-evidence/product-component.png)、[适配器来源](./m14-behavior-flow-evidence/product-adapter.png)、[运行轨迹](./m14-behavior-flow-evidence/product-trace.png)，以及 [桌面面板](./m14-behavior-flow-evidence/panel-desktop.png) 和 [375 像素窄屏](./m14-behavior-flow-evidence/panel-narrow.png)。结构入口位于实体选择和手动入口之后，排在旧来源列表之前。

从产品测试保存的项目日志重读并校验 [manifest](./m14-behavior-flow-evidence/persisted-manifest.json)、[explanation](./m14-behavior-flow-evidence/persisted-explanation.json) 和 [trace](./m14-behavior-flow-evidence/persisted-trace.json)，保留原记录引用；[归档清单](./m14-behavior-flow-evidence/evidence.json) 记录输入绑定及每个文件的 SHA-256。[验证摘要](./m14-behavior-flow-evidence/verification.json) 保留各组结果和仓库总检查日志摘要。

## 最终检查结果

- 能力采集完整构建及 12 组、120 项检查全部通过，失败、取消和跳过均为 0；包含项目工作流、面板和真实产品窗口。35 capabilities / 44 components / 50 tools，`product-integrated` 保持为 0，等待后续组合准入。
- AIStudio `npm run check` 通过：合同、类型、架构边界、上游/候选包与既有 quick gate，以及 32 项行为分析、5 项工作区、99 项工具和 23 项 G05 流程回归，均无失败、取消或跳过。
- milestones `npm run check` 通过；另行核对所有非 G05 Goal 的机器记录与变更前完全一致，M12 G12 / M13 G11 保持 blocked / active。归档文件摘要、文档链接和当前 census 输入绑定均通过复核。
- 产品截图来自总检查中的真实窗口；三类结构化记录从该窗口保存的项目日志重读，通过完整性校验并确认项目、Document revision、来源绑定和结构摘要相同。没有提交或推送代码。

## 范围说明

解释使用已有结构解释服务并标识 producer；不伪称由在线模型完成。调用表达式的进入表示开始求值，参数抛异常时不证明被调用函数执行；函数体入口才能证明调用已进入。没有调用实例标识的重叠执行不声明独立时长。超过预算的记录明确显示遗漏。

已经前进的 Play 加载重置时钟的 replay 时，旧轨迹结束；需要新启动的 Play 才会产生新代次的轨迹，不把旧 World 的状态伪装为从头回放。此次不新增回放控制台，也不更改既有 Play 授权。

七类项目验证行为浏览与来源定位；不替代七类游戏完整玩法、在线模型、物理/动画内部路径或后续高级编辑验收。G01–G04 历史摘要与 M12/M13 状态未改写。
