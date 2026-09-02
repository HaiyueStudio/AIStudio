# M13 Backend Session、capacity、compaction 与 cache adapter

Implementation binding: `m13-g04-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

G04 把 Harness Session 和 Codex thread 视为 `AgentSessionV1` 的可替换远端绑定，而不是第二份会话真值。Studio 的 append-only SessionOp、Surface、checkpoint 和 Transcript 始终可在 provider 进程消失后独立重建。

## Ownership and call flow

`BackendSessionRuntime` 位于 provider-neutral `agent-runtime`。应用插件会自动注册同时实现 `AgentBackend` 与 `BackendSessionAdapter` 的 Backend；DeepSeek/Cordis 类型仍只存在于 `harness-bridge`，Codex JSON-RPC 仍只存在于 `agent-backends`。

一次受管 turn 的组合顺序是：

```text
Studio Session replay/checkpoint
  → backendSessions.ensure(model, tools)
    → inspect remote id + confirmed Studio op boundary
      → reuse | stale | detach + open replacement
  → Backend startTurn(remoteSessionId, immutable ContextFrame)
  → persist complete Studio SessionOp boundary
  → backendSessions.confirmBoundary(opId)
```

`ensure` 按 Studio Session 串行，两个并发入口最多创建一个远端 Session。dispose 先拒绝新操作，再 drain 已开始的 open/reconcile。Provider open 失败时，已经写入的 `backend.detached` 和全部 Studio 产物保留，下一次 ensure 从相同 checkpoint 重试。

## Binding generation and recovery

- 第一次 open 写入 generation 1 的 active binding；重复 ensure 只有在 remote id、model 和 `lastConfirmedOpId` 全部匹配时复用。
- Provider 暂时不可查询时，binding 进入 `stale`，保留 remote id，不打开重复 Session。
- Remote missing、不可直接输入、model drift 或 boundary mismatch 会先持久化 `backend.detached`，再创建更高 generation 的 binding。
- 重绑结果返回 `checkpoint-replay-required`；调用者必须把当前 Studio Surface/ContextFrame 发送给新远端，不能读取 provider history 恢复 Studio。
- Provider 后续报告新的可信 Context Window 时，同一 remote id 只提升 binding generation 和 capacity，不重复 open。

## Pinned provider capability matrix

| Capability | Harness `dsh-v0.1.0-rc.7` | Codex App Server `0.148.0` |
| --- | --- | --- |
| remote identity | process-local Harness Session | ephemeral Codex thread |
| input Context Window | `unknown`；上游 `maxTokens` 是输出上限，不能冒充输入容量 | 初始 `unknown`；收到 `thread/tokenUsage/updated.modelContextWindow` 后升级 |
| native compact transport | 无公开 driver | 有 `thread/compact/start` |
| safe Studio mirror | 不支持 | 不支持；RPC 返回空对象且通知没有摘要/覆盖范围 |
| binding `nativeCompaction` | `false` | `false` |
| parallel tool transport | 当前配置为 1，因此 `false` | provider transport 可并行，报告 `true`；实际调度仍由 G06 决定 |
| Code Mode | 未启用，`false` | 未启用，`false` |
| usage/cache support | `reported`，单次缺字段仍为 unknown | `reported`，来自 token usage notification |

“有 compact RPC”不等于“可以安全改变 Studio Surface”。只有 adapter 能原子返回摘要、覆盖范围和来源证据时，binding 才能把 `nativeCompaction` 设为 true。`compactionSummarizer` 会把这种摘要继续交给 G03 两阶段发布，形成正式 `CompactionRecordV1`；当前两套 pinned Backend 都直接走 Studio fallback，Codex 不会为了探测而调用会隐藏修改 provider history 的 compact RPC。

## Usage and cache evidence

`projectBackendCacheEvidence` 输出两个不可混淆的来源：

- `localCas`：Studio artifact hit/miss 与 delta reuse bytes；只说明本地复用。
- `provider`：provider usage 明确报告的 hit/write tokens；缺失时为 `unknown`，不写成 0。Provider 声明不支持时为 `unavailable`。

`providerCacheEligibleBytes` 只说明稳定前缀具备命中条件，不是命中证据。即使 local CAS 全部命中，也不能推导 provider cache hit。Usage/cost 继续由既有 `UsageLedger`/accounting owner 记录，binding 只提供来源与 availability 解释。

## Failure boundaries

- remote inspection 网络/进程失败：`stale`，不丢 remote id、不重复 open。
- remote missing/boundary mismatch：detached + higher generation；Studio checkpoint 是恢复源。
- unsafe native compaction：结构化 fallback；不得推进 provider 或 Studio 隐藏历史。
- capability drift during open：fail closed，不持久化声称不准确的 active binding。
- adapter/session runtime disposal：拒绝 late write，drain 已开始操作，所有 Provider 资源仍由各 Backend owner 回收。

G04 不实现 Scene diff、multi-tool Scheduler 或 Execution Graph UI；G05、G06、G09 分别消费这里的 exact binding/capability/cache projection。
