# 通用参数化阵列

日期：2026-11-21

`scene.populate` 在一次 Document 事务中创建或更新整组重复对象。首版支持 XY、XZ、YZ 平面的行列网格，共用 origin、spacing、旋转、缩放和可选的 seeded palette，适用于棋盘、地砖、货架等重复几何。几何可以内联定义，也可以通过 `templateEntityId` 捕获现有单个几何实体；原型保留，带子节点或脚本的复合原型仍使用 assembly/prefab。

## 两种表示

| 模式 | 持久化与编辑 | 适用场景 | 上限 |
| --- | --- | --- | --- |
| `entities` | 一个分组根实体和每格独立实体；每格拥有稳定 ID、Transform、几何、材质及可选组件 | 各格需要独立编辑、交互组件、碰撞或刚体 | 128 格，同时受一次事务 1000 操作约束 |
| `instances` | 一个根实体和紧凑的 `haiyue.scene.array` 配方；编辑器和 Play 使用 Engine 原生 InstancedMesh3D | 大量同几何对象，由一个控制器按索引改变位置、颜色 | 4096 格，basic/PBR 材质 |

Instance 是 GPU 实例，不是独立 ECS 实体，不承载各格脚本或物理组件。交互可以使用独立输入面，按相同的网格坐标计算行列。根节点在视口中可通过实例的实际变换包围盒选中，移动根节点或其父节点会更新整组位置。

## 调用与编辑

创建时提供当前 `baseRevision`、项目内唯一的 `arrayId`、模式、layout 和 template。后续复用 `arrayId`；省略的 layout/template/representation 沿用已有值，提供的 layout/template 则替换整个对应部分。通过普通组件检查器修改阵列配方，也进入同一 Document 派生路径。

```json
{
  "baseRevision": 1,
  "arrayId": "tiles",
  "representation": "instances",
  "layout": {
    "kind": "grid", "rows": 20, "columns": 20, "plane": "xy",
    "origin": { "x": -9.5, "y": -9.5, "z": 0 },
    "spacing": { "x": 1, "y": 1 }, "seed": 17
  },
  "template": {
    "kind": "rounded-box", "material": "basic", "radius": 0.1,
    "scale": { "x": 0.9, "y": 0.9, "z": 0.9 },
    "palette": [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]]
  }
}
```

位置相对于根节点，spacing.x 沿列、spacing.y 沿行。格子的 key 为 `row:column`，线性索引为 `row * columns + column`。扩缩容后保留格子的 entity ID 和 seeded 颜色稳定；线性索引可能改变。工具只返回前 8 格样例，避免大结果进入模型上下文。

显式重新生成会重设生成格子的位姿和外观，移除模板不再包含的生成组件，保留另外添加的组件。缩容或 entities→instances 转换遇到独立子节点、脚本、额外组件、重挂父节点或外部引用时拒绝删除，整次操作不落盘。模式转换保留根节点 ID；若根节点已有脚本，结果标记 `requiresScriptReview`，不会改写业务代码。

## 保存、撤销与运行

唯一配方契约由 `studio-contracts/src/m12.ts` 和 M12 contract index 持有，输入按 unknown 校验，再由公共组件注册器验证。UI 和 Agent 共用 planner、Document 和 History；创建、扩缩容、模式切换及派生子实体共同占一个 History 条目。Undo/Redo 重放完整正逆操作，不重新派生，确保恢复之前的手工位姿。操作日志追加事实，保存恢复使用原有工程存储。

编辑态直接显示初始排列，不需要为了展示阵列生成初始化脚本。Play 脚本可获取已创建的实例集合：

```ts
const batch = api.scene.instances('返回的根实体 ID');
// batch.capacity 由配方确定，在本次 Play 中固定。
batch.set(0, {
  position: { x: 0, y: 0, z: 0 },
  scale: { x: 0.9, y: 0.9, z: 0.9 },
  color: [1, 1, 1, 1],
});
```

现有 API 的 set 使用世界坐标，省略 rotation/scale 时使用单位变换。脚本接管后静态配方系统停止覆盖实例缓冲。Stop 销毁隔离 Play 场景和 GPU 资源，编辑态与保存配方保持独立。观察结果包含实际实例数量及有界位置、颜色样例。

## AI 选择策略

中英文阵列/网格工具搜索优先发现 `scene.populate`。Prompt 明确要求按独立组件/物理需求选择 entities，按同几何批量显示和统一控制选择 instances，不逐格重复创建或配置。多部件对象继续遵守 assembly/prefab 计划。Agent 必须使用完整阵列范围取景并检查 Play 实例状态，不能悄悄降低数量或把复合结构替换成单几何。

沿用已批准计划和工程自动审批策略，不引入新的审批入口。阵列组件会派生其他实体，因此不被当作只改当前实体的安全操作；no-create、preserve-others 和复合体计划边界仍然有效。
