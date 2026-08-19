# ADR 0001：双 Agent Backend 与唯一根生命周期树

- 状态：Accepted for M06 POC
- 日期：2026-08-19
- 决策范围：G01-G10

## Context

M06 同时验证 DeepSeek Harness API-key 路线和本地 Codex 订阅路线。两者的认证、会话、审批和流式协议不同，
但必须共享 Studio 工具、Document mutation、审批、日志和对话投影。DeepSeek Harness/Cordis 本身提供组合与作用域机制，
M03 Editor Platform 也包含 PluginHost；若两套 host 同时拥有插件和服务，会产生重复 capability、不可证明的 teardown
顺序以及两个 History owner。

## Decision

1. `HarnessAgentBackend` 与 `CodexAppServerBackend` 是两个 `AgentBackend` 实现，不把 Codex 冒充 Harness LLM provider。
2. 全应用只有一棵由 `harness-bridge` 创建并拥有的 Harness/Cordis root effect tree。`studio-kernel` 暴露稳定的 Haiyue
   facade，不向业务插件泄漏 DSH 类型。
3. M03 的 `EditorDocumentHost`、`EditorHistoryService`、`EditorSelectionService` 与 `EditorTaskCoordinator` 作为 scoped
   provider 挂入根树。POC 不实例化 `EditorPlatform.plugins`，也不复制 service/contribution registry。
4. 所有注册、订阅、timer、Worker、child process、文件句柄和 GPU owner 都成为 root descendant effect；activation 失败
   逆序回滚，dispose/abort 幂等，迟到结果只能记诊断，不能写回。
5. Codex 0.148.0 采用 stdio App Server 和该版本生成 schema。Studio 工具采用 `dynamicToolCall` seam；此 seam 被标记为
   experimental，只能存在于固定版本 adapter 内。任何 schema 漂移都 fail closed。
6. Codex built-in shell/file/network 能力不映射为 Studio 工具。Studio 只注册 allowlist dynamic tools，tool request 必须先
   进入 Studio policy、approval 和 command pipeline。
7. 若固定版本失去结构化 dynamic tool surface，则重新评估 localhost MCP；禁止降级到 Markdown/自然语言解析或任意 shell。

## Consequences

- backend 可替换，但认证状态、rate limit、backend approval 仍保留来源语义。
- `harness-bridge` 是唯一可导入 `@deepseek-ai/*` 的包；`agent-backends` 是唯一理解 Codex wire schema 的产品包。
- Scene mutation 只有 `prepare -> validate -> approval -> revalidate -> commit` 一个入口，且 commit 绑定 document/base revision
  和 History transaction。
- M03 提供通用 Platform/Plugin SDK/Shell/app-kit；AIStudio 自己拥有 Scene product adapter，不消费 M03 私有 Scene 产品。

## Rejected alternatives

- 将 Codex 实现为 Harness provider：会丢失 App Server auth、thread/turn、approval 和 rate-limit 语义。
- 同时运行 Cordis root 与 Editor PluginHost：capability owner 和 teardown 关系不唯一。
- 直接让模型或 renderer 修改 ECS：绕过 revision、History、审批与 durable log。
- 解析模型 Markdown 发现工具调用：无法形成可验证、可拒绝的协议边界。

## Verification

`npm run boundaries:check`、`npm run upstream:check` 和 `npm run spike:check` 分别验证 import 边界、固定上游协议以及
两个 fake backend 的同构 tool/cancel 投影。
