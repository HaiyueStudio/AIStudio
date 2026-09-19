# P1：意图路由、约束执行与准备流程

本轮保留 P0 计费修复、现有工具审批及精确 revision/History 路径。完整 intent/0.1 外部 DSL 仍是设计稿；这里先实现其 source-bound 约束编译子集和 P1 执行修复，不声称任意自然语言已被可靠理解。

## 改动

- **只读与否定路由**：用保守的词法提示区分明确解释/检查与混合编辑请求。`readOnly` 只影响初始工具路由；只有“只检查 / Only inspect / read-only”等显式限制产生 `prohibitEdits` 和持久约束。普通“检查并提出方案”仍可在后续计划及工具审批后编辑，避免把任务阶段误当成永久禁令。只读初始 manifest 不再靠向量相似度凑满 20 个工具；显式禁止创建参与候选过滤。已有任务的工具清单仍然固定，可信的显式扩展不等于执行授权。实际执行另受约束守卫控制，`studio.tool.invoke` 和批次成员都经过同一 Host 路径。
- **按实际类型改色**：Host 把提交时 selection/revision 传到工具服务。服务读取既有不可变 Document 快照，geometry 目标选择 `material.set`，非 geometry 选择 `component.get/configure`；混合、缺失或陈旧目标保留两类发现入口。无额外模型请求，不从“按钮”这个名字推断类型。空对象或不支持的 UI 组件仍需 `component.describe`，不能虚构颜色字段。
- **可恢复的约束**：内部 `intent-constraints/1` 保留原请求、补充意见、UTF-16 来源范围、提交时 selection、document id/revision。编译结果写入唯一 M12 TaskSpec 的 `visibleConstraints`，必需约束单独进入 CAS 上下文，不随请求截断。审批补充意见累加，恢复读取原始 artifact，子任务接收全局约束；超出预算则留给父任务，不能截掉约束继续。
- **执行守卫**：明确只读阻止编辑；禁止创建允许已经确认不会增加实体的局部编辑；“选中对象之外保持不变”只允许实体局部 authoring 操作。preserve 基线只随已确认的本任务提交推进，外部 revision 变化会阻止继续修改或最终验收。Play 使用独立运行态，原有启动审批仍然生效，停止/清理始终允许。无法绑定的其他约束作为明确阻塞保留，不能假装已验证。这里的 preserve 指 authored state，并不宣称渲染结果、父子世界变换或任意脚本行为都不变。
- **单一断言解析**：evaluator 的 `parseEvidenceAssertion` 输出规范 AST，计划结构化输入归一化到同一兼容文本入口；验收工具路由也消费该 AST。保留现有 presence、equals/gte/lte、信号目录及审批前修正规则，不在审批后重写条件。
- **启动准备并行**：同一快照下，知识索引刷新与工具选择/必要上下文准备重叠；retrieval 保留刷新依赖。可选检索总等待上限 3 秒，失败形成明确上下文状态；必需 exact read 超时 10 秒则失败。取消后不发布 pending context，Host 关闭会取消准备 scope。该改动不把初始准备时间冒充 provider TTFT 或计费时间。
- **W7 报告准入**：旧 `qualify` 只定位报告，必须再通过内建加载器/验证器。报告绑定 backend/model/profileDigest/registryDigest/sourceRevision/cohort；至少 5 个独立成对 case，质量通过且 criterion digest 相同。从最终、非 step/tool 聚合 M12 Usage/Cost artifact 计算总 token/cost，不能使用未知值；并行侧必须有 parent、至少两个 child 的账本及 merge。完整任务墙钟覆盖合并；中位相对耗时 ≤0.9，token/cost 中位比值 ≤1 才接受。引用、digest、重复账本、来源绑定与字节限制均检查，加载等待有界。组合层仍负责可信的真实模型运行与 cohort 分类；没有可信端口/报告即退回父任务。

生产 W7 继续默认关闭。测试里的 `measurement: real-provider` 只是验证器的合成输入，绝不是实际收益证据，也不会写入生产准入配置。五对样本不支持 p95 或所有任务的收益结论。本轮未调用付费模型，不推进 G11 或任何里程碑。

## 可复现结果

[本地探针](intent-dsl/p1-fixed-findings.json) 使用实际工具定义、空组件目录、不提供目标绑定，统计工具 schema JSON 字节：

| 请求 | 修复前工具数 / 字节 | 修复后工具数 / 字节 |
| --- | ---: | ---: |
| 不要创建任何实体，只检查按钮颜色 | 20 / 27248 | 12 / 11197 |
| 解释一下什么是相机 | 20 / 24569 | 12 / 11197 |
| 把选中的按钮改成红色，保持其他对象不变 | 20 / 29664 | 15 / 13975 |

这些不是 provider token 或完整 HTTP 大小。实际 geometry/UI 绑定分别由定向测试覆盖。启动测试用可控依赖证明 exact query 在 refresh 释放前执行、retrieval 在 refresh 后执行，并检查取消与降级；没有声称测得真实 TTFT 降幅。

## 验证

最终路由修复后，定向 **95/95** 通过：`/private/tmp/aistudio-p1-routing-final.log`。覆盖实际 Host 审批后仍拦截明确只读编辑、事务/非事务路径、原约束与补充意见恢复、外部基线失效，以及 W7 合并开销、未知账本、质量下降、陈旧绑定和取消。未修改原有 `tool-contract-continuation` 断言，Harness/Codex 的固定清单复用与真实清单变化四项均通过。

第一次完整 `npm run check` 执行了全部 74 个集成文件（398 通过、10 失败），发现其中四项审批续跑失败是本轮把普通检查误当成永久只读造成，现已修复并由上述定向测试验证。其余失败分别是旧提示词正则、PNG 尺寸两项、产品窗口、材质光标和计划审阅；完整原始证据保留于 `/private/tmp/aistudio-p1-before-routing-evidence`。最终源码的能力报告与全量复验结果另记，不将前一轮失败改写为通过。

最终源码能力验证 **18 组、344/344** 通过，原 runner 重新生成 census/verification：`/private/tmp/aistudio-p1-capability-complete.log`。依赖先按 runtime → tools → orchestration 顺序完成 TypeScript 构建，capture 使用 `npm_config_ignore_scripts=true` 复用这些已构建依赖，仍重新构建应用并执行全部 18 组测试；未跳过测试、未手改报告。


最终完整 `npm run check` 已执行结束，exit 1：合同、类型、边界、依赖、quick 59、文档 19、行为 34、工作区 5、工具 192、逻辑 23 均通过。集成清单 **74 个文件全部执行，402 通过、6 失败**。审批续跑原有四项及 Host 生命周期 16 项均通过，先前本轮引入的只读回归已消除。完整日志：`/private/tmp/aistudio-p1-check-complete.log`。

剩余失败没有改断言或归为通过：

| 文件 / 项数 | 当前失败 |
| --- | --- |
| `g10-agent-integration` / 1 | 旧 `Inspect this before planning` 正则与已采用的按需读取提示词不一致 |
| `m14-g08-adapter-review/adapter-device` / 2 | PNG 尺寸 240 与预期 480 不一致 |
| `m14-integration/product-electron` / 1 | `native pointer focus` 超时 |
| `material-cursor-electron` / 1 | 读取未定义值的索引 `0` |
| `plan-review-electron` / 1 | renderer `Script failed to execute` |

这些失败在前轮也出现；本轮没有定位所有设备/界面问题的根因，不能据此宣称全仓绿灯或推进里程碑。最终测试输出与三份主日志归档在 `/private/tmp/aistudio-p1-final-evidence`，运行前 746 个输出文件按备份恢复，新增 runner TAP 仅在核对归档哈希一致后移除。清理后重新检查能力报告一致性、74 文件清单及 diff whitespace。W7 默认关闭，未调用付费模型、未提交或部署。
