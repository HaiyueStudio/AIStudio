# W7：按需启用的隔离子任务

W7 已提供可选子任务执行链路，生产默认关闭。复用既有 Host、AgentTurnRuntime、TaskAccount、CAS/Operation Log 和 W6 rolling scheduler，不创建第二个 root、工具注册表或 Document 写入通道。

预算与失败结算已按 [P0 修复记录](agent-efficiency-p0-fixes.md) 更新。下方原 W7 验证记录保留其当时结果；本轮验证另见该记录。

## 准入与调用

`ConversationHostOptions.subtasks` 是主进程组合层注入的可信端口。只有显式设置 `enabled: true` 才向父模型公开 `studio.task.delegate`；参数只能选择 2–4 个已批准的 `PlanTaskV1.id`，模型不能传后端、预算、权限、任意上下文或启用开关。

以下情况在子模型请求之前退回父 Agent：未开启、后端/模型与端口不一致、步骤未批准/已完成、步骤带依赖或写作用域、缺少明确输入/产物、产物键重叠、步骤估时低于 10 秒或合计低于 30 秒、输入事实不完整/过期、共享预算不足。估时只作保守筛选，不是实测收益。

组合层通过 `qualify(backendId, model)` 定位保留的真实 A/B 报告，再由 `qualification.load` 和内建验证器读取成对证据及 M12 账本，校验来源绑定、质量、总 token、成本、完整墙钟时间和父 Agent 审阅/合并开销；缺少有效报告返回父任务。具体格式与阈值见 [P1 修复记录](agent-efficiency-p1-fixes.md)。模型不能通过自己的计划文字使这个检查通过。当前没有将 fixture 结果配置为生产准入，也没有运行付费真实模型 A/B。小任务以及默认产品路径不会增加子模型请求。

## 上下文与执行

- 每个子任务只取得批准步骤的目标、该步骤明确引用的事实、精确 revision 和预期产物键。事实必须唯一、SHA-256 匹配、revision 匹配、通过既有脱敏检查；每份事实包最多 16 KiB。
- `PromptContextRuntime.prepareIsolated` 将完整子请求先存入原有 CAS，再传给模型。最多 24 KiB，不拼接父会话、项目全量快照、检索结果或历史摘要。
- `createRuntimeSubtaskPort` 使用现有 Harness backend 和 root runtime，创建独立 provider session。只提供 `studio.task.candidate` 数据返回入口，不给编辑器、文件、shell、审批或递归委派工具。父 TaskAccount 贯穿所有子 turn。
- 首个候选返回后取消并排空该子 turn，收集真实 usage，并用原 backend session adapter 的 detach 关闭 session。单请求 preflight 拒绝第二次准备/重试，实际序列化请求 UTF-8 字节加 framing 余量必须落在输入额度内，输出配置不能超出预留额度。
- 当前默认适配器只接纳具有 per-request preflight 的 Harness。Codex 原生工具尚无对应隔离能力证明，明确拒绝，不通过提示词假装禁用文件能力。provider-neutral 端口允许以后接入经过验证的适配器。
- 并发度固定为 2，单批最多 4 个任务。直接使用 W6 scheduler；超时/取消先发 abort，再等待实际退出。限时同时不超过可信配置与批准步骤的 wall-time 上限。组合层 qualify/facts 端口本身应是有界本地操作；facts 接收父 AbortSignal。

## 共享预算与候选合并

`TaskAccount.reserveWork` 在 dispatch 前同步预留各子任务的输入、输出和最坏成本，运行时间按 scheduler 整批限时预留一次。请求前还检查可用 turn 数，每个实际启动的子 turn 计一次 turn。预留通过可信适配器绑定具体 turn，已计入预算的真实消费从剩余预留中扣除；预留不伪装成 provider usage。真实 token、缓存和成本沿用 M12 Usage/Cost 账本，任务耗时按活动区间并集计算。

Harness 端口要求已知价格目录，按输入最贵档和输出/推理上界校验最坏成本。只有属于同一父任务、已精确绑定预留、终态且已知 token/价格的唯一子 turn 账本才能结清预留。候选无效或端口异常并不阻止已知最终消费结算；未知消费保留剩余承诺，不按零消耗退款。父任务后续工具/turn 也检查尚未结清的预留；硬预算继续使用原有用户授权续额路径。

返回值为版本化 `SubtaskCandidateV1`，只能包含 proposal/patch/test 候选文本、唯一预期产物键和已提供的来源引用。每子任务最多 8 个产物、每份文本 8192 字符、结果合计 64 KiB。返回键必须完整覆盖其声明，拒绝未知来源、重复键、额外权限字段或版本。合并顺序固定，不依据完成先后。

父 Agent 收到的只是候选，仍需自行审阅、验证，并通过原工具的 exact revision / prepare / approval / commit 流程写入；不自动执行 patch，不自动更新计划完成状态或验收证据。revision 在准备、启动、回收和交付时检查。失败成员可以留下其他成功候选；取消和过期结果不发布。

同父任务、模型、计划与项目 revision 的相同委派批次共享回执，成员顺序变化不重新运行。每父任务最多保留 32 个批次回执；到上限退回父 Agent，切换父任务或 dispose 清理。不同批次不做跨批的语义候选缓存。恢复中的任务暂时禁用新的子委派，避免进程丢失预留或 provider 回执后自动重放未知请求，父 Agent 仍可按现有恢复流程继续。

## 持久化与回滚

准入、启动和候选通过原 Operation Log / CAS 持久化；外层调用记录 SessionOp started/completed/outcome-unknown。交付异常保留候选 artifact，停止父 provider，不能把“未收到结果”当成“应重做写入”。日志不可写时不启动对应子请求。

省略 subtasks 或设置 enabled=false 即回退既有单 Agent/W6 路径。不改变现有 Document 事务或用户授权，不在运行中的事务上切换 effect 所有权。

## 验证

验证覆盖版本/敏感字段合同、未准入零请求、最小事实包、两路并行、预算原子预留、未知消费保留、来源/产物/revision 校验、取消等待真实退出、日志失败、Host 审批与回执复用，以及锁定 Harness 的真实协议链路（HTTP 使用本地 fixture）。后者已确认两个独立子任务各一次请求、同一父账本归因、两 session 关闭；输入超预算为零 HTTP；非结构化输出不作为候选。

最终定向回归：`/tmp/aistudio-w7-final-serial.log`，58/58 通过，包含 W7、共享计费、W3 请求上下文、W6 批次与 Host 生命周期。合同/类型/边界检查已通过，集成清单纳入 74 个文件。能力验证 `/tmp/aistudio-w7-capture.log`：18 组、344/344 通过，已更新源码绑定的 census/verification。完整仓库检查 `/tmp/aistudio-w7-check.log` 已执行结束（exit 1）：quick 59、文档 19、行为 34、工作区 5、工具 190、逻辑 23 均通过；集成 74 个文件全部执行，394 通过、6 失败。W7 新增测试全部通过。以上 fixture 仅证明执行边界与正确性，不证明真实任务的速度/token 净收益，不推进 M13 G11 或其他里程碑。


全量检查仍未全绿，失败与此前记录对应：

| 文件 | 失败数 | 当前结果 |
| --- | ---: | --- |
| `g10-agent-integration.test.mjs` | 1 | 旧提示词正则仍要求 `Inspect this before planning`，与 W1 已更新描述不一致。 |
| `m14-g08-adapter-review/adapter-device.test.mjs` | 2 | zero-script / mixed 的 PNG 宽度均为 240，断言要求 480。 |
| `m14-integration/product-electron.test.mjs` | 1 | 固定 Windows CPU/平台信息与当前 macOS 设备不匹配；与 W6 同一断言。 |
| `material-cursor-electron.test.mjs` | 1 | `Cannot read properties of undefined (reading '0')`；W5 已出现、W6 曾通过，本次再次复现，未声称已定位根因。 |
| `plan-review-electron.test.mjs` | 1 | renderer `Script failed to execute`；此前已出现，底层异常尚未定位。 |

没有删除或放宽这些断言。完整集成 TAP、截图和 `collected-tests.json` 归档至 `/private/tmp/aistudio-w7-integration-evidence`，确认 collectedFiles 与 executedFiles 均为 74；随后恢复本轮开始时干净的受跟踪 `test-output` 目录。W1–W6 原有源码修改保持保留。
