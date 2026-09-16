# W3：实际模型请求上下文

本轮把 Harness 的上下文控制接到每次实际模型请求，包括首次请求、同一 turn 的工具后续步骤和重试。固定 upstream 仍为 `dsh-v0.1.5-rc.2`；未修改上游包、私有循环或被冻结的请求对象。

## 请求准备与发布

1. `AgentTurnRuntime` 提供同进程的 `ModelRequestContextPortV1`。Harness 的公开 `llm/stream` waterfall 在 HTTP 前传入完整消息、工具 schema、输出预留、容量和最近一次成功请求的 usage。私有 replay/推理信息只贡献字节数，不进入 Studio 消息 artifacts。
2. `RequestContextRuntime` 生成不可变请求 manifest、消息 artifacts、工具目录 artifact 和压力记录。估计包含消息、schema、协议余量；最近一次 usage 只校准当前估计，绝不把累计账单 input 当作窗口占用。消息和目录 artifact 的本进程缓存有 4096 项上限。
3. 80% 尝试压缩；92% 在无法安全缩小时阻止新请求。容量未知保留 `unknown`。官方模型使用 pinned catalog；自定义容量可由受信配置 `harnessContextWindow` 显式传入。输出预留和 4096 token 安全预留分别计入。
4. 请求内容不可在 waterfall 直接改写。准备好的 replacement 通过一个仅本地的 finish/retry 边界，使用公开 `Session.append` Surface replace，再由原循环重建冻结请求。这个边界不会发送 HTTP，不消耗 provider retry 次数，也不会执行工具。重建后的完整请求再次预检。
5. 替换前用公开的 detached `Session.create` 校验范围。保留最后一个 native 工具调用/结果周期，拒绝拆开配对；更早内容中的最新各工具成功结果与调用参数保留为精确事实；最近错误独立保留，不能被同工具针对其他对象的成功结果覆盖。用户请求、当前 policy、任务摘要及项目 snapshot/delta 基线链均保留。普通历史摘录有明确的不完整标记和完整来源 manifest。
6. 引用型输入从 CAS 校验 digest 后补齐 projection。成功收到响应且 durable confirmation 成功，才确认 epoch、失效旧的 sent-artifact/baseline 记录。取消、准备失败、provider 失败、durable confirmation 失败均恢复原消息顺序和工具配对；历史 usage 不会因恢复而重复计费。

## Surface、恢复与证据

- 每个真正发送的请求都有 `agent/model-request-prepared`、实际 manifest 和对应 ContextFrame；失败或需要重建的候选也保留预检证据。ContextFrame 使用实际请求估计，不再把 UI transcript 当成 provider history。
- 成功确认的 replacement 经 Host 的已完成工具边界进入现有 CompactionRuntime：`requested → started → summary-created → completed`。原 Transcript、工具结果、审批和 mutation journal 不变。记录保留真实 before/after 压力与 pinned fact digests。
- 每次压缩以实际缩小和保留必需事实为准，不为了凑足 token 人为填充摘要。必需结果过大时明确阻止请求，不能靠切断 JSON、脚本、revision 或授权边界取得预算。
- 手动压缩后的 Surface 被下一次真实请求读取；本地摘录改为优先保留较新的内容。换工具集、重建 provider 会话或重启后，已持久化的摘要进入新请求的 task-summary；当前 policy/catalog 单独发送，旧 policy 不重复嵌入。
- 新增共享字段仅在 studio-contracts；上游类型仍仅在 harness-bridge。Codex App Server 的 native history 仍由其 backend 管理，本轮没有声称可拦截其内部每个模型步骤。

## 验证

新增测试覆盖未知容量、80% 压缩、92% 阻断、usage 校准、引用补齐、最新错误独立保留、manual Surface、工具集变化和重启恢复、配对拒绝、取消、provider/确认失败回滚，以及原始历史 usage 不重复入账。

`apps/ai-studio/test/harness-request-context.test.mjs` 使用真实 pinned Harness、backend、AgentTurnRuntime、Host、Session、ContextFrame 和 CompactionRuntime，仅替换 HTTP 响应及工具数据；连续四次真实请求中自动压缩，不增加 HTTP 调用，验证实际请求缩小、最后 native 工具结果完整、重复压缩后的 record 可读。

所有数据均为本地确定性 fixture。请求字节下降不等于实网 token 或费用下降；本轮没有调用付费模型，也没有推进 M12/M13/M14 正式验收状态。

为恢复仓库检查，同步修正了现有布局测试中 preview ownership、异步 refresh 参数及 UI 版本的过时断言，并将已有 query-cache 测试和 W3 回归加入 integration inventory。手动压缩执行图测试的夹具接入真实 `rememberManualSurface`，额外断言摘要恢复记录已持久化；未改变这些产品行为。

最终源码的专项回归（W3 四个测试文件与手动压缩执行图测试）共 15 项通过，无失败、跳过或取消。

`TMPDIR=/private/tmp npm run m14:capability:capture` 通过：18 组、344 项测试，重新生成与当前源码绑定的 capability verification/census。`product-integrated=0` 保持原有状态。

全量 `npm run check` 中，契约、类型、包边界、上游/引擎校验、M12 quick（59 项）、引擎文档（19 项）、行为（34 项）、工作区（5 项）、工具（184 项）、逻辑（23 项）检查均通过。最终 integration 检查发现以下阻塞，不能将全量检查记为通过：

| 测试 | 失败证据 |
| --- | --- |
| `g10-agent-integration.test.mjs` | 仍要求旧提示 `Inspect this before planning`；HEAD 已使用按需读取项目的提示。 |
| `g10-knowledge-source-loader.test.mjs` | 仍按 7 篇指南计算数量；HEAD 的指南清单已有 8 篇。 |
| `m14-g08-adapter-review/adapter-device.test.mjs` | 两个设备用例的截图 PNG 宽度为 240，断言要求 480；相关预览代码和测试未被 W3 修改。 |
| `m14-integration/product-electron.test.mjs` | 硬编码 Windows/i7-7700/8 核硬件信息，当前环境为 macOS/i7-9750H/12 逻辑核。 |
| `material-cursor-electron.test.mjs` | author 初始化读取未定义值的索引 `0`；该 UI 夹具未被 W3 修改。 |
| `plan-review-electron.test.mjs` | renderer 执行脚本失败；该 UI 夹具未被 W3 修改，尚未定位具体 renderer 异常。 |

最终 integration 执行完全部 61 个文件，336 项通过、7 项失败、0 跳过、0 取消；W3 四个文件全部通过。生成证据的敏感信息扫描通过。

完整本地日志：`/tmp/aistudio-w3-check-verified.log`；本轮逐文件结果及截图已保存在 `/private/tmp/aistudio-w3-integration-evidence/`（汇总文件为 `collected-tests.json`）。仓库中测试生成目录恢复为运行前版本，避免把设备截图和随机数据加入 W3 改动。这些验证阻塞保留原断言，没有跳过设备用例或将失败计为通过。
