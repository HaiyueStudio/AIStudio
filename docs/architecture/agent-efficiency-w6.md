# W6：计划 DAG 与完整工具批次

W6 在既有计划审批、工具调度器和 Scene transaction 上增加完整批次入口。没有新增 Agent、注册表或 Document 修改通道，也不增加单独的模型规划请求。

## 已实现

- **可选计划 DAG**：`PlanTaskV1` 随原始 `studio.plan.propose.items[].execution` 提交，保留逻辑步骤 ID、依赖、已知输入引用、预期产物、读写范围、验证、预算建议和耗时估计。简单任务可以省略；使用时所有步骤必须有完整元数据、唯一 ID 和无环依赖。整体 DAG 计划限 12 KiB，给审批投影的 16 KiB 上限留出空间。
- **审批和恢复**：批准某步骤必须同时选择其前置步骤，不会自动扩大批准范围。依赖保留在 Shell 投影、恢复计划和后续模型提示中。`studio.plan.update` 在整批更新后检查依赖，允许一次更新“前置已完成、后续开始”，禁止越过未完成步骤。进度仍不是验收证据。
- **封闭批次协议**：新增 `studio.tool.batch`，版本 1，最多 32 个成员、512 KiB 参数。它是传输入口，不注册成编辑器 effect，也不占据成员的 effect lock。所有成员先通过图、工具注册和精确版本验证，再进入原 Host 的 normalize、预算、prepare、审批、execute/transaction、日志和结果路径。
- **已知输入与前向依赖**：同批成员使用完整字面量参数，`dependsOn` 可以指向后面的成员。没有输出插值、嵌套批次或任意代码入口。需要新返回的 ID、revision 或搜索引用时，由模型读取结果后提交下一批；script/Play/preview 继续用独立原生调用。
- **保守并行判断**：调度边由 Host 的注册定义、校验参数和 revision 决定。模型不能声明自己的执行权限或并行类别。不同显式 revision 的状态读取串行；静态文档白名单沿用 W2。估计收益为串行耗时减去受依赖、effect 屏障和 4 个并发槽约束的耗时，再减去每成员 2 ms 的估计调度成本。缺少估计或收益不为正时并发度为 1；这些都是优化建议，不是计费或实际耗时数据。
- **实际传输字节计量**：有效批次按子工具逐项扣执行预算，输出字节按完整外层信封计量一次，包含协议字段；不重复累计内部成员结果。子结果限额保留 256 KiB 给最多 32 个成员的关联和调度说明，继续约束模型输出体积。
- **确定的结果顺序**：实际完成顺序可以变化，日志提交和外层 `results` 始终保持输入顺序。返回并记录 `schedule`，包含串行/并行理由、依赖、隐式屏障和估计收益。
- **事务和失败传播**：独立低风险修改仍可合入现有事务；Document commit 保持串行。被其他节点依赖、依赖其他节点或要求 stop-batch 的修改走完整执行路径，使依赖看到实际修改结果，不能把准备成功当作提交成功。失败取消依赖链，stop-batch 取消未完成工作。
- **显式 Harness step 边界**：将固定版本上游的 `step/start`、`step/end` 映射为稳定的 step/batch ID 和关闭事实；工具事件携带相同关联。已标记批次中的 text/usage 不再制造批次关闭。旧后端没有这些字段时保留原来的增量兼容路径。完整编辑批次通过新入口绕开上游 exclusive 工具逐个交付的限制。
- **持久依赖修复**：SessionOp 的 `dependsOn` 必须指向操作日志 ID，不能直接使用工具节点 ID。完整 DAG 按拓扑顺序落下 planned 操作，Host 映射两种 ID 后再启动成员；增量路径也使用该映射。闭合批次的成员共享同一持久启动屏障，避免每个 journal 写入分别推迟独立工具的启动。
- **用户检查点**：Host 产生的审批、查询额度或安全预算检查点可以停止同批未启动成员，不依赖模型是否声明依赖。已启动工作先排空；完整外层结果交付和记录后才取消 Backend turn，保留待审批节点。
- **取消和恢复**：静态调度器与 W5 rolling 调度器一致，超时先发 AbortSignal，再等待真实工具退出。修复反向排列依赖链失败时的错误 deadlock。外层调用另有 started/completed/outcome-unknown 记录；交付不确定时保留子工具及事务回执，恢复时不能把未收到外层响应误判为未执行修改。

## 合同与限制

共享类型和运行时校验位于 `packages/studio-contracts/src/workflow.ts`；发布的 JSON Schema 为 `w6-plan-task.schema.json` 和 `w6-tool-batch-input.schema.json`。合同测试同时核对 Schema 一致性、有效输入、无效输入、未知版本和带敏感字段的额外信封属性。

计划中的作用范围、步骤预算和耗时是模型建议；真正的预算与授权仍由既有 Host 逐成员检查。W6 不自动把自然语言步骤转换为工具调用，不执行多 Agent，也不声称能从字符串 ID 判断一个尚未产生的对象存在。工具实际参数和对象/revision 仍由既有工具服务验证。

取消无法强制杀死一个不响应 AbortSignal 的任意 Promise；调度器保留所有权并等待真实退出。这样不会在旧修改还活跃时释放调度屏障。

批次 Schema 增加固定的原生工具描述开销；简单任务继续直接调用原生工具。每成员 2 ms 只是可审计的估计参数，目前没有真实模型计费或生产时延标定。

## 验证记录

新增测试覆盖闭合批次的前向依赖、原序结果、并发上限、未知/负收益退化、错误版本、递归入口、脚本屏障、隐式屏障导致的环、反向依赖失败传播、不完整准入、取消真实退出和日志 hook 失败排空。

Host 测试覆盖计划授权、无效信封、修改执行失败后的依赖取消、显式 step 中穿插文本、准入期间取消、外层交付失败保留成员回执。计划测试覆盖部分审批、依赖进度与投影/提示保留。

固定版本 Harness + Host + 真实 OperationLog/Session 的本地 HTTP fixture 已通过三种场景：

| 场景 | 模型 HTTP 请求 | 实际准备工具数 | 观测并发读取 | 事务 |
| --- | ---: | ---: | ---: | ---: |
| 前向依赖读取 | 2 | 3 | 2 | 0 |
| 两次修改 + 文档 + 状态读取 | 3（包含原方案审批） | 4 | 1（文档与事务重叠） | 1 |
| 前置读取失败 | 2 | 2（依赖成员不启动） | 2 | 0 |

这些测试真实执行固定 Harness 的工具调度与请求组装，但 HTTP 响应由 fixture 提供，编辑工具使用受控替身。它们证明执行关系、原生结果交付和日志恢复，不能作为真实 DeepSeek token 降幅或端到端提速数据。

最终定向测试 **75/75 通过**：审批/传输/闭合调度 20 项（`/tmp/aistudio-w6-checkpoint-final.log`），其余协议/计划/调度/兼容回归 55 项（`/tmp/aistudio-w6-remaining-focused.log`）。合同门禁为 55 schemas、10 fixture files、56 valid、91 invalid cases；71 个集成测试文件已纳入清单。先前广泛回归 138 项中，唯一失败是桥接测试的旧事件列表未包含新增 step 边界；已更新为验证明确的开闭事件，并包含在最终 55 项通过结果中。

最终源码能力验证 **18 组、344 项全部通过**（`/tmp/aistudio-w6-capture-verified.log`），census 与 verification 已重新生成。顶层 `TMPDIR=/private/tmp npm run check` 已完整运行（`/tmp/aistudio-w6-check-verified.log`）：合同、类型、边界、上游和候选包检查通过；quick 59、文档 19、behavior 34、workspace 5、agent-tools 190、logic 23 项均通过。最终集成 **71 文件、374 通过、5 失败**，因此全量门禁仍未通过。W6 新增测试在集成轮次中全部通过。

本轮集成证据已保存到 `/private/tmp/aistudio-w6-integration-evidence`（包含 `collected-tests.json` 和每文件 TAP）；随后只恢复了原本干净、由测试改写的 `apps/ai-studio/test/m14-integration/test-output`。能力记录保留最终源码绑定。没有修改任何 milestone 状态，也没有运行真实付费模型或宣称生产 token/端到端性能达标。


## 顶层检查中的未通过项

本轮集成检查复现以下 4 个文件中的 5 项失败；保留原测试及断言，不将它们从清单移除：

| 文件 | 失败项 | 本轮实际错误 |
| --- | ---: | --- |
| `g10-agent-integration.test.mjs` | 1 | 仍匹配旧提示 `Inspect this before planning`；当前提示要求仅查询缺失/失效的项目事实。 |
| `m14-g08-adapter-review/adapter-device.test.mjs` | 2 | zero-script/mixed 两种路径的 PNG 宽度为 240，断言期望 480。 |
| `m14-integration/product-electron.test.mjs` | 1 | 将机器信息写死为 Windows/i7-7700/8 核；当前机器是 macOS/i7-9750H/12 核。 |
| `plan-review-electron.test.mjs` | 1 | renderer `Script failed to execute`，底层异常尚未定位。 |

前几轮已记录过这些文件的问题。本轮产品测试已越过 W5 的原生窗口焦点等待，失败于之前 W4 也出现过的硬件信息断言；不能把它描述成与 W5 相同的焦点故障。`material-cursor-electron.test.mjs` 本轮通过。
