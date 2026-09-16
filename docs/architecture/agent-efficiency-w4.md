# W4：精确工作集与结果去重

本轮沿用唯一 PromptContextRuntime、ContextRouter、工具注册表和 Host 执行路径。没有新增模型调用、审批策略、Document 写入入口或跨 revision 的验收复用。

## 已实现

- **精确工作集复用**：完整且已经确认发送的 Scene slice，在 provider session、工具合同、project/document、exact source owner、scope/projection、revision 和 manifest 均相同时复用。无需再次调用 exact query；上一轮的 scoped delta 也可按原 artifact 引用。截断/分页未结束、owner 重建、选中范围变化、版本变化、epoch 失效或重启时读取/发送完整所需上下文。App 的 exact source 在同一项目 Host 内保持身份，Host 重建后更换身份。
- **紧凑工具目录**：native 描述和 schema 已发送，context manifest 只保留工具 ID 与 schema digest。同任务工具合同签名仍包含完整描述和 schema，合同变化继续触发重绑。
- **知识片段去重**：以 citation（source、kind、package version、revision、content digest、字符及行范围）、权限、project/document、完整 excerpt 和 capability IDs 作为身份。检索分数和时间戳变化不触发重复正文。同轮重复只发送一次；同 provider 会话已确认的片段发送 reference-only。新片段、版本/权限/项目变化、重启和压缩后的 epoch 失效均重新展开。可选知识因预算被裁掉时不会成为“已发送”事实。
- **统一 CAS 引用**：知识正文作为 ContextArtifactV2 的 `knowledge-hit` 存储，正文 digest 与 CAS digest 一致；原检索 artifact 留在审计引用中。W3 可以校验并展开这些引用。ContextRouter 验证每个候选的权限、版本、revision 和 citation 后才做同范围去重，不能靠重复项绕过校验。
- **可执行的结果**：Host 不再让 summary/digest-only 提示丢掉工具的实际返回合同。IDs、revision、proposal、diagnostics、分页和 observation 保留；`script.get` 等源码读取完整保留。未知结果形状保持原值，避免引入补读。
- **工具搜索去重复 schema**：仅当搜索命中的 inputSchema 与本轮实际 native 工具 schema 完全相同时省略该字段，并标明 `schemaSource: native-tool` 与 schema digest。省略工具、schema 漂移和非搜索结果完整保留。nextTool、invocation/version、effect/risk 和 nextCursor 保持不变。只有节省超过引用成本时才应用，原始返回先落 CAS，再记录带原始/投影字节数和 artifactRef 的 durable 事件，最后送给 backend。
- **确认顺序**：上下文 commit 的 durable index 写入成功后才发布本进程复用基线。失败不会把未确认内容变成 reference-only。

## 边界与回退

`PromptContextRuntime` 的第 4 个参数 `{ compactContext: false }` 回退完整目录、知识正文及原有查询路径；runtime plugin 与 POC profile 的 `compactContext` 参数可传递此开关。`ConversationHostOptions.compactToolResults: false` 回退完整搜索结果。默认开启。它们是受信配置，不接受模型指定。结果的 ID/源码保全是正确性要求，回退也不会恢复丢字段行为。

本轮不跨 revision 复用局部事实或验收结论，也不缓存 Play tick 等动态读取。任务摘要继续执行现有 revision 失效规则。更细粒度的事实依赖失效需要明确完整依赖关系，不能仅凭“不同实体”猜测安全。

## 验证

- runtime：完整/不完整工作集、未确认准备、scope/revision/manifest/source owner 切换、provider epoch、重启、回退开关和 durable commit 失败。
- knowledge/router：检索排名变化、版本变化、相同/不同范围、权限拒绝、CAS digest、W3 实际压缩引用展开。
- result：原始 ID/revision/proposal/诊断/源码/分页/evidence 保全，native/omitted/schema drift 的区别。
- 真实 pinned Harness + Host + runtime：分别开启/关闭 W4，均执行 2 次工具、3 次 HTTP 模型请求；从前一返回的 nextTool/revision 构造下一调用，无补读；原始搜索结果 artifact 可按 digest 回溯。

所有模型响应为本地 HTTP fixture；请求字节数变化不代表实网 token、费用或端到端耗时收益。没有调用付费模型，也不推进正式里程碑验收。

相关 runtime/orchestration 全包及 W3/W4 Harness 链路回归：179 项全部通过，无失败、跳过或取消。搜索结果样例为 3470 → 2854 字节，工具仍为 2 次、HTTP 请求仍为 3 次。契约校验通过（54 valid / 85 invalid fixtures），包边界检查通过，integration inventory 已纳入 3 个 W4 文件，共 64 个文件。

`TMPDIR=/private/tmp npm run m14:capability:capture` 最终通过：18 组、344 项，生成与当前源码绑定的 verification/census。首次采集的 Electron 面板 Escape 用例失败；相同源码下单独复测及整轮重跑均通过，没有放宽断言。日志分别为 `/tmp/aistudio-w4-capture.log`、`/tmp/aistudio-w4-panel-recheck.log`、`/tmp/aistudio-w4-capture-final.log`。

`TMPDIR=/private/tmp npm run check` 已完整运行。类型、契约、包边界、上游/引擎检查、M12 quick、能力证据、文档、行为、工作区、工具（184 项）和逻辑（23 项）全部通过。最终 integration 执行 64 个文件：345 项通过、7 项失败、0 跳过/取消；W4 新增 9 项全部通过，生成证据的敏感信息扫描通过。

全量检查仍未通过。失败与 [W3 已记录的阻塞](./agent-efficiency-w3.md) 一致：旧项目工具提示断言、旧知识指南数量、两个截图尺寸断言、硬编码 Windows 硬件信息、材质窗口初始化、计划评审 renderer 脚本。未修改这些断言，也未把失败计为通过。

本轮完整日志：`/tmp/aistudio-w4-check-final.log`；逐文件 TAP、汇总及截图：`/private/tmp/aistudio-w4-integration-evidence/`。仓库的测试生成目录恢复为运行前版本，保留 W4 源码、测试、文档及当前 capability verification/census。
