# Root plugin ownership

```text
Electron main bootloader
└─ harness-bridge: Harness/Cordis root scope (唯一生命周期根)
   ├─ studio-kernel: typed service/event facade
   ├─ editor providers: DocumentHost / History / Selection / Task / Scene adapter
   ├─ operation-log
   ├─ desktop shell and renderer panel plugins
   ├─ preview runtime owner
   └─ agent runtime（profile 选择一个 backend）
      ├─ HarnessAgentBackend → transport child fiber
      │  └─ AgentRegistry / SessionStore / LlmRuntime / SystemPrompt / ToolRuntime / AgentLoop / client
      └─ CodexAppServerBackend child-process scope
```

## Ownership rules

- bootloader 只负责 Electron 进程边界、协议校验器和创建 root；不承载产品能力。
- root scope 的 child 激活成功后才可发布 capability；失败时 child 内 effect 逆序释放。
- Editor public service class 由 adapter 创建并注册到同一 root。禁止实例化其独立 `EditorPluginHost`。
- `History` 只有一个实例，手工 UI command 和 Agent tool 共享它；Document revision 是 mutation 的并发令牌。
- backend 切换释放旧 turn、provider client 或 Codex process 后再激活新 backend。backend 不拥有工具或 Document。
- renderer 是 typed intent/view projection 客户端，不拥有 fs、secret、child process、policy 或 mutation。
- 会话业务流程由 `agent-orchestration` 包承担；Electron scope 注入项目与平台接口，在初始化前登记 conversation 的释放动作。依赖方向与模块职责见 [Agent orchestration boundary](agent-orchestration.md)。

## Harness composition and initialization rollback

- `createPinnedHarnessAgentTransport` 必须传入 `createHarnessStudioRoot` 创建的根，或该根提供的 `StudioPluginActivationContext`。transport 不创建 Cordis 根；bridge 内部映射 facade 到真实作用域，Cordis 类型不穿透公共接口。
- 产品 profile 将 agent runtime 的 activation context 传给 backend factory。独立 smoke / acceptance runner 显式创建并释放自己的 Studio 根。
- 固定版本的 Harness 注册根级 `agent` accessor，因此每个 Studio 根同时只允许一个 Harness transport。重复创建在加载任何上游插件之前拒绝；释放、禁用或 profile replacement 后可以重建。
- transport 的上游插件、adapter、client 和会话都归属其 child fiber。部分初始化失败释放整个 child；根的 fiber 计数包含这些后代，不能只统计顶层 Studio 插件。
- agent runtime 在调用 backend factory 前登记初始化清理，并在每个资源创建后记录释放动作。索引、提示上下文、会话适配器注册或 service 发布失败都会逆序回收；未能注册的 backend 也必须释放。
- owner 失效后等待正在进行的初始化结束，回收迟到的 factory 结果，并禁止发布服务。正常关闭先清理 runtime，再释放 transport 子树；重复释放共享同一次清理。

验证位于 `packages/harness-bridge/test/bridge.test.mjs`、`packages/agent-runtime/test/lifecycle.test.mjs` 和 `apps/ai-studio/test/agent-profile.test.mjs`，覆盖真实 Cordis/Harness 组合、产品 profile、失败回滚及迟到结果，不需要模型请求或 API key。

## Nested teardown proof obligation

G02 必须以失败注入验证：第 N 个插件 activate 抛错时，前 N-1 个插件的 effect、Editor providers 和外部 owner 全部释放；
连续两次 dispose 无副作用；cancel 后迟到 promise 不能注册 capability 或提交 Document。验证未通过时不得接入产品插件。
