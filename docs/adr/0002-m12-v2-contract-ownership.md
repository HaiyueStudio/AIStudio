# ADR 0002: M12 v2 contract ownership and public capability seams

状态：Accepted for M12 implementation  
Binding：`m12-g01-2026-08-24`

## Context

M06 的 v1 contracts 足以证明单 root lifecycle、受控工具、Document/History 和双 Backend POC，但不能表达模型推理配置、成本真实性、缓存来源、组件化 GameDocument、运行观测或验收证据。继续在各功能 Goal 内增加局部 envelope 会制造第二套 task、usage、component 和 observation 真值。

Engine `0.1.0` 已通过公共 subpath 暴露大量 camera、physics、lighting、material、postprocess、particle、asset 与 serialization 能力，但 AIStudio M06 主要重建 primitive SceneSnapshot。另一方面，固定步长、输入注入、通用相机跟随、prefab authoring、完整 Play observation 等能力缺少适合编辑器消费的公共 seam。

## Decision

1. `@haiyue/ai-studio-contracts` 是全部 M12 provider-neutral envelope 的唯一 TypeScript owner；`config/contracts/schemas/m12-*.schema.json` 是 wire/schema owner。
2. schema version `2` 与 M06 version `1` 并存。迁移由 G05/G03 等 owner 显式执行；不得原地放宽 v1 或让消费者私自定义兼容形状。
3. `m12-contract-index.json` 为 contract→owner→consumer 的机器真值；未分配 owner 或 schema/TypeScript 名称漂移时 G01 gate 失败。
4. `m12-capability-census.json` 为 capability classification 真值。`available-public` 只能经已安装 public package export 或绑定的 upstream public package证明；`missing-seam` 必须先走 Engine/Editor expand-and-contract。
5. AIStudio 不导入 Engine/Editor 私有源码，不把 live World、GPU、physics backend、DOM 或 mutable component 暴露给 Agent。Component Registry 只保存 schema、序列化值、adapter id、risk/effect 和 lifecycle owner。
6. 成本未知必须编码为 `status: unknown` 且金额、币种和公式均为 null。Provider cache、local CAS 和 context delta 是不同事实。
7. 任务只有在 required acceptance 对应的 evidence 可读取且预算/安全 gate 未违反时完成；模型 terminal、mutation 或 preview started 均不是完成证明。

## Consequences

- G02–G11 可以扩展实现与 schema-compatible minor data，但不能创建第二套共享 envelope。
- public Engine 能力仍需 AIStudio adapter、序列化与 teardown tests 后才能标为 integrated；“引擎存在”不等于“Agent 可用”。
- 缺失的固定步长、replay/input injection、follow camera、prefab authoring 和 observation seam 会形成显式 upstream work，而非跨仓深导入。
- M06 v1 fixtures 继续通过，允许 expand-and-contract 和项目迁移回滚。
