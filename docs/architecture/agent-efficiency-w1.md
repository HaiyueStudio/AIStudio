# Agent 效率优化 W1 实施记录

日期：2026-09-16。范围对应 [优化方案](./agent-efficiency-optimization-plan.md) 的 W1：减少重复上下文、重复发现和无效会话重绑。

## 实现

| 项目 | 当前行为 | 主要落点 |
| --- | --- | --- |
| Policy 去重 | 模型投影只传一份正文和 profile 的 id/version/digest；完整模块清单存入 CAS，操作日志保留审计引用 | `packages/agent-runtime/src/prompt-context.ts` |
| 按需发现 | 已有同版本 schema、文档、实体事实和最新确认 revision 时直接复用；缺失、作用域扩大、外部失效或 stale-revision 才补查 | prompt modules、`plan-policy.ts`、工具说明 |
| 同任务稳定工具集合 | 按 taskId/backendId 记录首次选择的有序工具 ID，计划审批、参数修正和预算续跑不再使用通用续跑文案重排工具；重启从操作日志恢复 | `packages/agent-orchestration/src/conversation-host.ts` |
| 真实合同变化仍重绑 | 每次从当前 registry 重建定义；schema、描述、版本或查询阈值变化仍改变签名；历史记录不能恢复已删除工具或提供执行 schema | 同上 |
| 参数错误直接反馈 | `tool.arguments-invalid` 附带失败工具精确版本的 schema；小 schema 完整返回，大 schema 返回最多 4 KiB、8 个字段的明确标记片段，缺失约束才搜索 | `packages/agent-orchestration/src/tool-correction.ts` |

Prompt profile 升级为 `3.10.0`。任务工具选择记录使用 `conversation/task-tools-selected` / schemaVersion 1。旧记录不存在或无效时按当前任务目标正常选择。新增能力通过既有上下文签名机制生效，不引入另一套可执行工具注册表。

未改变事务、精确 revision 校验、审批及失败重放规则。schema 反馈仅供模型修正参数，不能自动改参、自动重放或作为替代验证器。上下文中的遗漏仍表示未知，不能推断对象不存在。

## 测量

| 指标 | W1 前 | W1 后 | 差异 |
| --- | ---: | ---: | ---: |
| Policy 投影 JSON 字节 | 9,215 | 4,878 | 减少 47.1% |
| 使用新正文比较重复布局与单份布局 | 10,016 | 4,878 | 减少 51.3% |

W1 前数据来自 [本地基线](../evidence/agent-efficiency-baseline-2026-09-16.json)。这是单个 policy artifact 的 UTF-8 JSON 字节测量，不等同于整次模型请求的 token 或实际费用降幅。完整 profile 仍可从 CAS 读取；只是不再把其中模块正文重复发送给模型。

## 验证范围

- Prompt：正文只传一次、审计引用可读、稳定 digest、已有上下文恢复和 revision delta 行为。
- 工具选择：三个中文任务跨计划/修复续跑、重启、registry 枚举顺序变化仍稳定；真正版本变化重绑，删除工具不恢复，独立任务/后端分别选择。
- 错误反馈：字段与 enum 精确返回，大 schema 有界，版本不匹配不附带错误合同，不确定提交结果不触发自动修正。
- Harness/Codex 集成：合同不变时复用 provider session 并发送引用；真实合同变化时重建 session 并发送完整上下文；编辑仅执行一次。
- 工具发现集成：保留未知工具、递归 invoke、合同版本、计划及 revision 校验。原测试等待第二次脚本审批已不符合现有计划内精确授权行为，调整为验证计划批准前零执行、批准后精确 argsDigest/baseRevision 授权和单次提交；未修改生产审批实现。
- 工具发现单测：使用明确的 core-only 初始集合验证 omitted tool 的搜索与调用，避免把语义排名结果当作固定前提。

验证结果：

- W1 核心定向测试：44/44 通过；工具发现路由单测：4/4 通过；Harness/Codex 合同续跑集成：4/4 通过；工具发现集成：2/2 通过。
- `TMPDIR=/private/tmp npm run m14:capability:capture`：18 组、344 个测试通过，0 failed/skipped/cancelled；生成清单覆盖 58 个工具，`product-integrated` 仍为 0。
- `TMPDIR=/private/tmp npm run check`：合同、类型、边界、依赖、候选包、协议、59 个评测、能力清单、19 个文档测试、34 个行为测试均通过；工作区组 4/5 通过，停在原有 `apps/ai-studio/test/split-layout.test.mjs:35` 静态断言。
- 该断言期待 `frame.start(previewScene, plan)`，而已提交的 `renderer.ts:1931` 使用 `frame.start(previewScene, plan, agentPreviewOwnership.active)`。两个文件本轮均无改动，已在 HEAD 核对同样的不一致；不将整仓检查报告为通过。
- 被此断言阻断的检查另行执行：`m14:agent-tools:test` 184/184 通过，`m14:logic:test` 23/23 通过；`m14:integration:test` 在执行测试前被既有 inventory 漏项阻断：已提交的 `packages/editor-plugins/test/resources/query-cache.test.mjs` 未列入 `scripts/m14-integration-tests.json`。相关文件本轮无改动；未绕过清单检查，未声称最终集成组通过。
- `git diff --check` 通过。未提交或推送代码。

macOS 验证环境使用 `TMPDIR=/private/tmp`：默认临时目录 `/var/folders/...` 经系统符号链接映射到 `/private/var/folders/...`，会被 ProjectAgentHistory 的路径校验拒绝。使用真实路径后，相关历史记录/IPC 的 5 个用例全部通过；未修改生产路径校验。能力证据通过仓库 `m14:capability:capture` 生成，绑定当前整个工作区（包括已有改动），仅表示本地检查，不推进里程碑。

全量捕获还暴露了既有离线清单遗漏：`assembly.create`、`assembly.inspect`、`assembly.instantiate` 已在执行 registry 中，却未登记到 `m14-capability-sources.json`。已补入现有 resources 组；不新增运行时能力，也不提升 acceptance stage。生成文件由标准捕获命令重建。

## 后续边界

W1 不包括 W2 的 Harness 只读并发接线，也不包括 W3 的 provider 请求边界压缩。没有调用付费模型；搜索次数、端到端时延和 token 降幅仍需相同任务的真实模型对照评测。
