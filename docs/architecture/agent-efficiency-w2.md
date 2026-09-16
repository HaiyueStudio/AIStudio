# Agent 效率优化 W2：接通 Harness 只读并发

日期：2026-09-16。基线提交：`7c90aa5`。范围对应 [优化方案](./agent-efficiency-optimization-plan.md) W2 / 第 5.3 节阶段 A。

## 行为

同一模型响应中的独立只读工具，现在可以经固定版本 Harness、HarnessApiKeyBackend、ConversationHost 到既有 RollingToolBatchScheduler 同时执行。默认最多 4 个；不新增 Agent、模型规划请求、执行 registry 或 Document 写入路径。

- `ToolConcurrencyHintV1` 是 Host 生成的 provider-neutral 元数据，有版本和边界校验。未知版本、额外字段及无效目标不能授予并发。
- Host 复用既有 `classifyToolConcurrency()`，只有注册表确认的 `parallel-read` 获得并发提示；第一轮保守保留所有 script 工具独占。计划、审批、写入、Play 和未知工具保持独占。
- `studio.tool.invoke` 使用从完整当前 registry 派生的安全目标 ID/版本列表，覆盖未进入 native surface 的工具。bridge 只对合法 envelope 和精确版本匹配的只读目标放行；Host 仍解析真实目标并执行原 schema、预算、效果、授权与 revision 校验。
- Bridge 映射提示为 pinned Harness 的 `isConcurrencySafe`，同时将 AgentLoop 和 ToolRuntime 上限设为 4。未携带提示的旧调用方仍全部串行。
- 元数据不进入模型 schema。工具集合签名包含并发提示和 invoke 目标版本；注册表安全性变化需要正常重绑，不能复用旧 provider 合同。
- provider 与 Host 都保留调用顺序提交；只读执行完成顺序可以不同。取消排空在途调用，晚到结果不能重新完成已取消调用。

回退：`createPinnedHarnessAgentTransport({ maxParallelToolCalls: 1 })`；产品 profile 的对应选项为 `harnessMaxParallelToolCalls: 1`。合法范围为 1–4，默认 4；1 时 Session 的 `parallelToolCalls` 能力为 false。该选项在创建 transport 时生效，不改变已提交事务或用户授权。

## 主要代码

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 共享合同 | `packages/studio-contracts/src/tool-concurrency.ts` | 版本化提示及 fail-closed 校验 |
| Host | `packages/agent-orchestration/src/tool-concurrency.ts`、`conversation-host.ts` | 按当前注册表生成 native/invoke 提示 |
| Runtime | `packages/agent-runtime/src/index.ts`、`backends/types.ts`、`tool-set.ts` | start/open 传递与验证提示，绑定会话签名 |
| Bridge | `packages/harness-bridge/src/harness-agent.ts` | upstream 安全分类、并发上限、真实能力声明与取消清理 |
| 产品装配 | `apps/ai-studio/src/profiles/agent-game-authoring.ts` | 暴露串行回退配置 |

HarnessApiKeyBackend 的 start/open 已完整转发工具合同，沿用该通道，不复制分类逻辑。Codex 的模型工具 schema 仍只接收 id/description/inputSchema。

## 验证与观测

新增 `read-concurrency.test.mjs` 直接运行 pinned Harness，只有 HTTP 模型响应使用本地 fixture；新增 `harness-read-concurrency.test.mjs` 再接入真实 backend、Host、runtime、scheduler、OperationLog 和 Session，工具体使用可控完成门闩。

已验证：

- 上限 1/2/4：6 个同响应读取按对应宽度到达，在结果被扣留期间不超过上限；provider 历史中的工具结果顺序不变。
- 真实 Host 链路：4 个读取在任何结果释放前全部进入执行，实测 `maxActive = 4`、此时已交付结果数为 0；其中一个通过 invoke 调用被省略的 `scene.get-many`。
- 故意按 3、2、1、0 完成工具，provider 与持久记录仍按 0、1、2、3 提交；单个失败不取消独立读取；恢复历史不重放调用。
- mutation/unknown 屏障将读取分组；invoke 的写入目标、过期版本、伪造 policy 字段、递归及未知目标保持独占。
- 4 个在途读取取消后，剩余 2 个不启动，晚到结果被拒绝，同 Session 可正常开始下一轮；root dispose 清空全部 pending calls 和 fibers。
- 并发分类变更影响会话签名；invoke 中未暴露目标的安全性变化同样触发重绑。

串行和并行 fixture 都只有 2 次模型请求（一次工具响应、一次最终答复）。W2 证明读取等待可重叠，不将调度并发宣称为模型轮数或 token 降幅；未调用真实付费模型。

定向回归：117/117 通过，0 failed/skipped/cancelled。覆盖 contracts、全部 harness-bridge 测试、backend conformance、backend session/prompt context、同任务工具选择、并发提示、完整/rolling scheduler、真实 Harness→Host 并发、合同续跑和 batch lifecycle。

新增 W2 用例可单独复现（先完成 workspace build）：

```sh
TMPDIR=/private/tmp node --test --test-concurrency=1 \
  packages/studio-contracts/test/tool-concurrency.test.mjs \
  packages/agent-orchestration/test/tool-concurrency.test.mjs \
  packages/harness-bridge/test/read-concurrency.test.mjs \
  apps/ai-studio/test/harness-read-concurrency.test.mjs
```

完整验证结果（macOS 使用真实 `TMPDIR=/private/tmp`，保持生产路径校验不变）：

- `npm run m14:capability:capture` 成功：18 组、344 个用例通过，0 failed/skipped/cancelled。生成的 verification/census 绑定本次工作区；仅为本地回归证据，`product-integrated` 仍为 0，没有推进里程碑。
- `npm run check` 已执行：contracts、类型、边界、上游/候选包、协议、59 个 eval、能力清单、19 个文档测试、34 个行为测试通过；工作区组 4/5 通过，停在 `apps/ai-studio/test/split-layout.test.mjs:35`。
- 该旧断言期待 `frame.start(previewScene, plan)`，基线源码实际使用 `frame.start(previewScene, plan, agentPreviewOwnership.active)`；W1 已记录同一问题，本轮未修改相关文件。
- `npm run m14:integration:inventory` 也已预检，仍有 W1 记录的旧漏项：`packages/editor-plugins/test/resources/query-cache.test.mjs` 未登记。未绕过 inventory，未声称完整 M14 integration 通过；被工作区失败阻断的后续总检查阶段也不记为通过。
- `git diff --check` 通过。没有调用真实付费模型，没有提交或推送代码。

## 保留的边界

本轮不接入完整 step/batch-close 协议、不支持模型在批内引用尚未返回的 IDs，也不让编辑调用越过 upstream exclusive 分组。固定文档读取与写入仍可能被 Harness 串行化，即使下游 scheduler 支持它们重叠；这是后续阶段 B 的工作。依赖前一步结果的操作继续放在后续模型 step。W3 的真实请求上下文压缩未在本轮实现。
