# 按验收目标选择证据

先确定要证明的事实，再选择工具。不要把每个测试步骤都截图送给多模态模型。

| 验收目标 | 工具与证据 | 注意事项 |
| --- | --- | --- |
| 对象数量、层级、几何体、材质及贴图绑定 | `scene.query` / `scene.get-many` / `assembly.inspect` | 这是编辑文档配置；不能证明 Play 中的对象已运动或像素正确 |
| 实际位置、旋转、缩放、相机 | `play.inspect`，`state` 证据 | 运行时引擎对象数据；不是脚本自行上报的成功标记 |
| 点击、拖拽、输赢规则 | `play.pointer-gesture` 或 `play.input` + `play.step`，再检查对象、相机、事件与 gameplay | 必须执行输入，并验证实际结果；仅有事件或计分变化不等于物体已移动 |
| 错误、固定步进、清理 | `play.inspect` / `play.stop`，`runtime-errors` / `performance` / `lifecycle` | 现有 performance 记录 tick/frame/timeMs/finite，不提供 FPS |
| 颜色、贴图是否可见、光照、遮挡、视觉布局 | `play.capture`，再实际查看图像 | 同一测试阶段复用图片；相关画面变化后再拍。截图存在不等于视觉正确 |

## 只读取受影响的对象

从创建结果或场景查询取得真实对象 ID，然后调用：

```json
{"entityIds":["entity:actual-target-id"],"includeGameplay":false}
```

这是 `play.inspect` 的参数示例；示例 ID 必须替换成工具返回的 ID。
省略参数保留原来的完整检查行为。单次最多选择 128 个对象，较大的集合分批读取。
要比较同一个时刻的批次，先 `play.step` 暂停模拟。

`state.entities` 按请求 ID 顺序返回找到的对象；`selection.missingEntityIds` 明确列出缺失 ID。
先检查缺失列表为空和每个返回对象的 `id`，再使用数组下标构造验收路径。
`selection.totalEntityCount` 是原快照对象总数，选中数组的长度不是全场景数量。
`inspectionScope` 标记局部查询与是否包含 gameplay，不会伪装成全量数据。
若 `projectionTruncated` 为 true，缩小查询范围；未截断的选中快照已持久化，供 `task.evaluate` 使用。

`state.entities[i].position/rotation/scale` 是父级局部空间值，旋转单位是弧度。
`transform.set` 接受的 `rotationDegrees` 是角度，比较时必须转换。
不能把局部坐标直接与指针命中点的世界坐标比较；需使用已知层级变换，或在同一局部空间检查。
相机状态在 `state.camera`。省略 gameplay 不会隐藏相机、运行错误或事件。

## 数据验收示例

旋转交互的流程：读取目标与相机基线 → 执行完整 down/move/up 手势 → 读取目标与相机终态。
确认目标确实改变、预期不动的相机保持不变。游戏规则可同时检查 `gameplay[i].value`，
但脚本上报不能取代引擎中的对象数据。

已知旋转后的预期数值时可定义两个独立的 functional 条件（ID 和数值都来自当前项目）：

```text
evidence state signal state.entities.0.id equals "entity:actual-target-id"
evidence state signal state.entities.0.rotation.1 gte 0.5
```

向 `task.evaluate` 传入 `play.inspect` 返回的证据引用。不同阶段用 `acceptanceEvidence`
绑定对应证据，避免把起始态和结束态都要求在同一个 tick 成立。浮点结果使用允许误差的 gte/lte 范围。
纯数据验收可以全程不截图。

外观相关任务应拆成“材质/几何/绑定配置正确”的数据检查与“实际画面正确”的视觉检查。
不能为了减少截图删除视觉要求。当前内置确定性评估器没有自动视觉分析生产器；
真实图像审阅与未验证的外观要求需如实说明，不能把 `evidence screenshot` 的存在检查宣称为视觉通过。
数据与画面不一致时，保留 `play.capture` 同一 tick 的截图和状态作为排查证据。
完成测试或准备修复前调用 `play.stop`。
