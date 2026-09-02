# M13 有来源 RAG 与按需工具 Schema

Implementation binding: `m13-g10-2026-09-02`

G10 在 exact context 与注册表真值之上增加本地检索层。它只帮助模型找到相关知识与能力，不拥有 Scene、诊断、审批、任务、成本或验收事实，也不允许检索失败阻塞编辑。

## 数据流与优先级

```text
ProjectDocument / Scene query+diff / Operation Log
                 │
                 ├── exact facts（最高优先级）
Durable SessionOp│
                 ├── structured summary + graph relation
Component Registry + reviewed engine guides + project/asset metadata
                 │ content hash / tombstone / local embedding
                 └── authorized current KnowledgeHit + citation
                                      │
                         exact → durable → semantic
                                      │
                              Context / model turn
```

实时项目状态始终来自 exact query/diff。Prompt 先放 policy、能力清单、durable summary、项目 snapshot/delta，再放有来源的 KnowledgeHit；语义命中不能覆盖前面的事实。检索刷新使用独立的 1500ms deadline 和子取消信号；异常或持续无结果都写入 `knowledge/refresh-degraded` 并回退 exact context，任务继续执行。

## 索引所有权

- 工具目录只读取 `GAME_AUTHORING_TOOL_DEFINITIONS`；组件目录只读取 `ComponentRegistry`。G10 不复制第二份 schema 真值。
- 引擎组件、引擎指南、当前项目结构元数据、受控 Asset metadata 与 Session decision 使用 content hash 增量写入 Operation Log CAS。
- 组件或项目 revision 替换、项目关闭、Asset 清空都会产生 tombstone。重启按 Operation Log 顺序重建；稀疏大型日志用自适应 sequence window 避免扫描预算阻塞。
- 项目脚本只索引 identity、能力与 digest，不索引 source；Asset 只索引受控 metadata，不读取二进制正文；secret-shaped 内容和网络 URI 在写入前拒绝。

## 检索与路由边界

检索采用 BM25 风格关键词、可替换的本地 embedding、关系图距离和稳定 rerank。结果携带 source、kind、package version、project revision、content digest、字符/行引用、permission scope、retrieval method、score、rank reason 与 token budget。

候选在排序前按权限、source kind、capability、package version 和 project revision 过滤。冲突 claim 被整体扣留；无结果显式返回 diagnostic。Context Router 再次校验权限、版本、revision、stale 标记和 citation 一致性，防止绕过检索运行时注入任意 artifact。

## Tool discovery

模型始终得到十个稳定 core tools。`ToolCatalogRuntime` 使用与知识检索相同的本地语义匹配对精确工具和组件注册表分组、排序；每个任务最多扩展 18 个完整工具 schema。`tool.search(includeSchemas)` 可显式展开后续需要的少量合同，所有 mutation 仍由原工具注册表的 effect、risk、approval 与 validation 执行。

## 默认开启门禁

七类独立需求以全部固定 schema + exact-only retrieval 为控制组，以按需 schema + hybrid retrieval 为实验组。默认开启要求：工具覆盖率不下降、Recall@8 不下降、引用完整率 100%、schema 字节下降至少 25%、总估算输入 Token 下降至少 20%。任一条件不满足即保持 opt-in。
