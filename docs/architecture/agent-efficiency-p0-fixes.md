# Agent 预算与子任务结算 P0 修复

对应 [意图 DSL 检查](intent-dsl-proposal.md) 中的三个 P0。修复不启用 W7，不改变计划审批、Document effect 权限或 provider 价格；不涉及 DSL 接入。

## 预留与真实消费只计算一次

`TaskAccount.bindWork` 将预留绑定到可信适配器实际创建的 turn。拒绝绑定预留前存在的父 turn、其他任务、缺失 turn、已归属另一预留的 turn，以及已结算 turn；同一绑定幂等。

账本每次更新后按 metric 计算：

```text
预计占用 = 已确认消费 + Σ max(0, 对应预留上限 − 该 turn 已计入预算的消费) + 新增分配
```

输入继续沿用现有净新增 token 预算语义；输出和费用分别扣减。未知 sibling 不再使整个任务的已确认消费消失。审计 Usage/Cost 总计仍保留 unknown/null；预算内部保留各 turn 最后已知的消费，不将未知伪装为零，也不将预留伪装为 provider usage。

例如 cap=200、两份100预留、其中一份已上报50：已用50 + 剩余150 = 200，下一 turn 可以进入。重复/乱序事件不重复扣减，较新累计修正会重新计算；真实越额仍锁定硬停止，只有原有授权续额路径可解除。

## 任务耗时按活动区间并集计算

`UsageLedger` 保留内部活动区间，`TaskAccount` 对同一任务的区间求并集。父任务与两个子任务同时覆盖0–100ms时，任务耗时为100ms，各 turn 原有100ms记录仍可用于统计累计工作时间。串行的不重叠区间继续累计，不能用最大单次耗时代替。

Host 的既有 `WallTimeBudget` 同时拥有活动计时 scope，把 scope 内的模型协商、工具等待、清理排空等纳入任务活动时间。嵌套人工等待暂停；结束后固定时间边界，迟到 usage 只改消费，不延长已经退出的活动区间。续跑打开新的 scope，重叠区间仍只算一次。

计时沿用现有执行预算边界：首次 Host context 准备完成、account 建立后启动；提交消息到首次 context 准备完成的检索/路由时间不在该 scope 内。因此此字段是执行预算耗时，并非 UI 从提交到完成的全链路延迟；TTFT/全链路延迟优化仍属于后续工作。

W7 按 scheduler 的整批限时预留一次 wall time，不再按 lane 数相加；已经过时间从这份预留扣减。scope 在真实 drain 后关闭，已知耗时不因 token 未知而永久占额。每个子请求仍保留各自 token/费用预留。

活动区间属于 runtime 内部元数据。没有增加第二套 M12 Usage/Cost/Budget 合同，也没有修改 provider 的 per-turn UsageRecord 结构。非 Host 调用仍可从 ledger 的已观测活动区间计算任务时间。

## 候选是否有效不决定是否结账

`SubtaskPort.run` 接收 Host 的 turn 绑定回调。默认 Harness 适配器从首个事件开始报告精确身份，失败路径也可追踪。

调度成员在 port 实际退出后的 finally 进行结算：账本必须属于绑定 turn、执行已终止、最终 input/output 和价格已知。成功候选、非法候选、无结构化输出、已知消费的取消均按真实消费结算；未知消费继续保留剩余承诺。模型响应中的 turnId 不能替换已绑定身份，账本不能重复结算。候选仍由父 Agent 验证，不自动成为验收通过或 Document 修改。

端口在尚无可信 dispatch/usage 证明时失败，仍保守保留 token/费用预留。本次没有把“没拿到候选”或“没有返回 usage”当成免费请求。

## 回归与证据

- [原始探针结果](intent-dsl/current-findings.json) 保留为修复前记录。
- [修复后探针结果](intent-dsl/p0-fixed-findings.json)：100ms 重叠区间报告100ms；50已用 + 150预留，allowed=true，无 hard-stop latch。
- `p0-accounting.test.mjs` 覆盖精确归属、重复/乱序/修正、未知 sibling、缓存与费用、终态前拒绝释放、并发/串行/嵌套暂停/迟到消费、Host scope、整批时间预留与真实超额。
- W7 编排测试覆盖已知失败、无效候选、取消与未知消费；真实 pinned Harness 协议链路使用本地 HTTP fixture，验证候选成功和无结构化输出都结清已知消费，session 均关闭。未调用付费模型。
- 最终定向41/41通过：`/tmp/aistudio-p0-final-focused.log`。runtime/orchestration 包与 Harness 共215项，初次211通过、4项因 macOS 临时目录符号链接被安全检查拒绝；使用 `TMPDIR=/private/tmp` 重跑该文件4/4通过：`/tmp/aistudio-p0-project-realpath.log`。未放宽路径安全检查或断言。
- 集成发现执行图、会话重启、G10 使用的手写 accounting fixture 缺少活动计时接口。三个文件改用真实 `TaskAccountingRegistry` / `UsageLedgerStore`，保留原断言。相关16项中15通过，仅保留既有的 `Inspect this before planning` 文案正则失败：`/tmp/aistudio-p0-host-real-accounting.log`。
- 初次 Electron 窗口进程在执行沙箱中提前退出；同一用例在允许桌面启动的环境1/1通过。后续能力验证使用相同环境。测试替身更新后，依赖源码没有变化，最后一次 capture 复用先前已构建的依赖，重新构建应用并执行全部能力组；未跳过测试或手改生成的验证报告。

能力验证18组344/344通过，源码绑定的 census/verification 由原 runner 更新：`/tmp/aistudio-p0-capability-verified.log`，包含预算检查点恢复18项、任务续跑25项、执行状态31项。

完整 `npm run check` 已执行结束，exit 1：合同、类型、边界、依赖、quick 59、文档19、行为34、工作区5、工具190、逻辑23均通过。集成清单74个文件全部执行；65份完整TAP统计为346通过、4失败，另9份因中断/超时缺少完整统计，因此不能给出完整集成用例总数，更不能宣称全绿。日志见 `/tmp/aistudio-p0-check.log`，原始集成证据完整归档至 `/private/tmp/aistudio-p0-integration-evidence`。

设备验证出现明显计时停顿：多个100秒限时用例记录了十几分钟到近两小时的耗时。仅对9份不完整结果及1个项目切换超时文件补跑，保留原记录，补跑期间使用进程级 caffeinate 防止闲置休眠，不改系统设置、不增加测试限时。补充证据单独存放于 `/private/tmp/aistudio-p0-rerun-evidence`，不替换原全量检查结果。

全量仍包含旧提示词正则、PNG尺寸、材质光标、计划审阅失败；补跑还出现 gameplay 设备计时停顿、产品窗口 native pointer focus 超时，以及曾在能力验证中通过的 G11 续跑等待超时。尚不能将这些都归为既有失败或本次代码回归；它们是本次全量验证的明确限制，没有修改相关断言或将不完整结果记为通过。

补跑已结束：10个文件中9份完整TAP合计47通过、4失败，gameplay 设备文件再次因异常长停顿缺少完整统计。预览窗口、展开面板、资源面板、W7 Harness 3项、项目切换4项和上下文16项均通过；失败为PNG尺寸2项、产品窗口焦点1项、G11续跑1项。G11单独原样重跑仍超时；仅在超时路径加入状态打印的临时诊断副本随后在相同等待限时下通过，说明结果对时序敏感，但未定位根因，不将原失败改记通过。临时诊断文件已移除，记录为 `/tmp/aistudio-p0-g11-isolated.log` 和 `/tmp/aistudio-p0-g11-diagnostic.log`。

所有验证进程已结束。626个原始受跟踪 test-output 文件按运行前备份恢复，本轮新增的24份 TAP 在核对归档内容一致后从工作区移除。原始与补充证据均保留在上述 `/private/tmp` 目录；能力证据一致性、74文件清单和 diff whitespace 检查再次通过。没有提交、修改已有失败断言或推进里程碑，W7仍默认关闭。
