# M13 Scene query/diff 与增量 Context Router

Implementation binding: `m13-g05-2026-09-01`  
Contract binding: `m13-g01-2026-09-01`

G05 建立当前项目事实的 exact data path。Document/History 仍是 Scene 真值，Operation Log 仍是 diagnostics、evidence 和 play trace 真值；Context Router 只生成有界、不可变、可追溯的模型输入，不拥有第二份项目状态。

## Ownership and data flow

```text
ProjectDocument + History transaction
        │ GameDocumentDeltaV2 + command/history event id
        ▼
SceneContextRuntime
  base snapshot + at most 2048 retained deltas
        ├─ scene.query(revision, scope, projection, cursor)
        └─ scene.diff(fromRevision, toRevision, scope, projection, cursor)
                         │
Operation Log cursors ───┼─ diagnostics / evidence / play trace
Durable CAS refs ────────┼─ session memory
Knowledge CAS refs ──────┼─ approved semantic hits
                         ▼
ContextRouterRuntime: exact → durable → semantic
                         ▼
CAS artifacts → ContextFrameV1 → Backend request
```

`ProjectWorkspace` 在创建、打开或替换 Document 时冻结一个基线，在 command、undo、redo 的同一 Document mutation path 记录 delta。录入前必须把 delta 从当前 retained revision 完整重放，并与权威目标 Document digest 比对；不一致时丢弃旧窗口、以权威目标建立新基线，使调用者得到明确的 history-pruned recovery，而不是错误 diff。`transactionIds` 来自 Document History delta；`provenanceOpIds` 当前保存触发 mutation 的持久 Studio Operation Log event id，使修改可以回溯到 command/history 请求。G06/G09 可以把这些 id 继续连接到 SessionOp/Execution Graph，但不得在 G05 伪造尚不存在的 SessionOp。

进程重启后只从当前 Document 建立新基线，不假装旧 revision 仍在内存。调用旧 revision 会得到 recoverable `scene.history-pruned`，Router 显式执行 bounded snapshot recovery；它不会静默返回不完整 diff。

## `scene.query`

Query 支持 `hierarchy`、`components`、`scripts`、`assets`、`camera`、`render`、`settings` projection，以及 scene/entity/component type scope。默认页为 100，单页最多 1000 条；返回总数、截断状态、下一 cursor、结果 digest 和不含脚本正文的安全 snapshot digest。

Script projection 只包含 identity、entity、path、text revision、enabled、order、capability 和 source digest，不包含 source text。Asset projection只包含受控 metadata/digest/source 标记，不读取 binary。全量脚本文本仍只能通过已有显式、有界、带权限的 script tool 获取。

Cursor 携带 document、revision range、scope/projection fingerprint 和 offset，并用内容完整性摘要保护。参数变化返回 `scene.cursor-stale`，损坏或篡改返回 `scene.cursor-invalid`。

## `scene.diff`

Diff 按 `SceneDiffV1` 返回：

- Entity add/remove/rename/reparent/reorder；
- Component field paths 和目标 digest；
- Script/Asset add/update/remove；
- Asset dependency 变化；
- 主相机设置和相机 component 变化；
- render/light component 与 render settings 变化；
- settings key、tombstone、transaction 和 provenance；
- stable full-diff digest、分页 cursor 和目标安全 snapshot digest。

分页只改变本页 change arrays、`truncated` 与 `nextCursor`；每一页保留相同的完整 diff digest。消费者取齐页面后可按 change category 重放，并用 `targetSnapshotDigest` 与目标 query 的 `snapshotDigest` 比对。这个 digest 刻意用 script digest 代替 script source，既能检测代码变化又不会把正文复制进常规上下文。

失败采用显式状态：future revision、pruned history、revision gap 和 stale/invalid cursor 都是 recoverable；反向 revision range 等调用错误 fail closed，不触发 snapshot recovery。

## Context routing and immutable frames

每次 route 的顺序固定为：

1. exact Scene snapshot/diff；
2. diagnostics cursor delta；
3. evidence cursor delta；
4. play trace cursor delta（作为 evidence 类输入、使用独立 cursor）；
5. durable memory artifacts；
6. approved knowledge hit artifacts。

每段投影先写入内容寻址存储，再以 artifact id、digest、source revision、估算 Token 和 required 标记进入 `ContextFrameV1`。Frame 在 Backend 请求前冻结；后续 revision 只能进入下一帧。Router 不解析或重排 knowledge 内容，因此 semantic retrieval 永远不能覆盖前面的 exact facts。

首次或 recovery 使用 bounded snapshot；存在连续 revision 时只使用 diff。diagnostics/evidence/play trace cursor 在未命中事件时仍推进扫描高水位，避免稀疏事件重复扫描或丢失；投影只包含 sequence、kind、severity、source、correlation、artifact refs 和 payload digest，不暴露 raw payload。

## Product integration

`project.snapshot` 已收敛为项目 identity、revision、saved/dirty、计数、registry digest 和日志健康摘要。应用的 Prompt Context 组合层注入 provider-neutral exact source：新会话发送 bounded query，revision 改变发送 diff；恢复失败时发送标注原因的 snapshot recovery。旧调用者没有 exact source 时仍保留兼容 manifest delta，但桌面产品主链路不再通过 manifest 发送完整 Scene 或 script source。

## Boundaries

- 不读取 live Engine World，不暴露 GPU、DOM、Shell、网络或项目外文件。
- 不把 RAG、摘要或 Backend history 当作 Scene、diagnostics 或 evidence 真值。
- 不承诺跨进程保留内存 revision window；缺失时使用有证据的 snapshot recovery。
- 不实现 G06 多工具 Scheduler、G07 transaction/effect lock 或 G10 semantic retrieval ranking。
- 查询和 diff 都有页数、字节和工具 result 上限；无界输出必须失败或分页，不能退回完整项目 dump。
