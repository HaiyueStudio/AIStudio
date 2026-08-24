# M12 Engine/Editor capability census

Binding：`m12-g01-2026-08-24`  
Machine source：[`config/contracts/m12-capability-census.json`](../../config/contracts/m12-capability-census.json)

## Reading the result

- `available-public`：版本化 package export 已存在；仍需 AIStudio adapter、序列化和 lifecycle tests 才能成为 Agent tool。
- `available-internal`：AIStudio/Editor 已有内部 contract，但 M12 envelope 或产品接入可能不完整。
- `available-experimental`：只能由 reviewed candidate/experimental seam 消费。
- `missing-seam`：所需边界不存在；必须先 expand-and-contract。
- `not-supported`：上游和产品均无可用能力，需显式 scope 决策。

## Findings

Engine `@haiyue/engine@0.1.0` 已公开 Camera2D/3D、InputMap、InteractionSystem、2D/3D physics、lights/shadows、PBR materials、postprocess、2D/3D particles、AssetManager 和 ComponentSerializationRegistry。AIStudio M06 没有把绝大多数能力映射到 Scene Document 或 Agent tools；这是“能力存在但未接入”。

必须新增公共 seam 的项目是：确定性 input injection、fixed-step/replay、可序列化 follow/bounds camera、prefab authoring contract，以及 AIStudio 自身的 multi-script Play、state/screenshot observation 和 acceptance evaluator。

动画位于 Engine 仓公共 `@haiyue/extensions/animation`/`animation3d` subpath，但 AIStudio 未安装该包；音频只有 `MusicPlayerComponent` 的公共 runtime surface，当前包含 URL/fetch 行为，不能直接暴露给 Agent。两者都必须经过受控 asset adapter。

Editor `0.1.0` candidate 已提供 DocumentHost、HistoryService、SelectionService、TaskCoordinator 和 lifecycle/plugin contract。G05 应复用这些 owner，而不是再造 History 或 task scheduler；其缺口是 GameDocument v2 component transaction，而非基础 Editor host。

## Critical integration order

1. G05 先建立 Component Registry 与 v2 transaction/migration。
2. G06–G08 仅消费 census 中的 public path；`missing-seam` 先提交上游 candidate。
3. G09 建立单一 multi-script Play owner。
4. G10 才能把 input/state/screenshot/performance artifacts 绑定到 Task acceptance。
