# Root plugin ownership

```text
Electron main bootloader
└─ harness-bridge: Harness/Cordis root scope (唯一生命周期根)
   ├─ studio-kernel: typed service/event facade
   ├─ editor providers: DocumentHost / History / Selection / Task / Scene adapter
   ├─ operation-log
   ├─ desktop shell and renderer panel plugins
   ├─ preview runtime owner
   └─ agent runtime
      ├─ HarnessAgentBackend
      └─ CodexAppServerBackend child-process scope
```

## Ownership rules

- bootloader 只负责 Electron 进程边界、协议校验器和创建 root；不承载产品能力。
- root scope 的 child 激活成功后才可发布 capability；失败时 child 内 effect 逆序释放。
- Editor public service class 由 adapter 创建并注册到同一 root。禁止实例化其独立 `EditorPluginHost`。
- `History` 只有一个实例，手工 UI command 和 Agent tool 共享它；Document revision 是 mutation 的并发令牌。
- backend 切换释放旧 turn、provider client 或 Codex process 后再激活新 backend。backend 不拥有工具或 Document。
- renderer 是 typed intent/view projection 客户端，不拥有 fs、secret、child process、policy 或 mutation。

## Nested teardown proof obligation

G02 必须以失败注入验证：第 N 个插件 activate 抛错时，前 N-1 个插件的 effect、Editor providers 和外部 owner 全部释放；
连续两次 dispose 无副作用；cancel 后迟到 promise 不能注册 capability 或提交 Document。验证未通过时不得接入产品插件。
