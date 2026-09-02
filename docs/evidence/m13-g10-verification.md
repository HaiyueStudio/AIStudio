# M13 G10 candidate verification

Implementation binding: `m13-g10-2026-09-02`  
Formal Goal gate: `npm run m13:g10:check`

G10 的候选实现包含本地内容哈希索引、关键词与 embedding 混合检索、关系图召回、权限/版本/revision 过滤、冲突扣留、citation、按任务选择工具 schema，以及失败回退 exact context 的生产接入。

正式证据包括：

- Agent Runtime 测试覆盖命中引用、exact 优先级、权限、版本、旧 revision、冲突、无结果、secret 拒绝、tombstone、图遍历和重启重建；
- Context Router 测试证明 semantic 输入排在 exact/durable 之后，并通过独立策略校验；
- Source Loader 测试证明组件注册表、项目修订、Asset metadata 与项目关闭能正确索引或 tombstone；
- Tool Catalog 测试证明中英文能力检索、稳定 core tools、显式 schema expansion 与固定 schema 缩减；
- 七类游戏 A/B corpus 覆盖贪吃蛇、消消乐、俄罗斯方块、拼图、平台跳跃、竞速和射击；正式数值写入 `m13-g10-retrieval-ab.json`。

只有 `m13-g10-retrieval-ab.json` 的 `status` 为 `default-enabled` 且完整 gate 通过，产品才采用 hybrid retrieval 与按需 schema；否则仍以 exact-only 和固定注册表合同运行。
