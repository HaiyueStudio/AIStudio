# 交互故障诊断：先定位链路，再修改代码

使用 `play.pointer-gesture` 的 `expect` 明确本次预期：`cameraChanged`、
`changedEntityIds`、`changedTransformEntityIds`、`unchangedEntityIds`、`minChangedEntities`。旋转/位移使用 `changedTransformEntityIds`，避免仅改变颜色也被当作移动。这只是本次测试的诊断预期，
不取代用户批准的验收条件；不得降低预期来绕过失败。

例如对组合体的可见面拖拽，先从 `scene.get-many` 获取真实对象 ID 和层级，
确定应该移动的成员及保持不动的成员，再提交：

```json
{
  "points": [
    { "phase": "down", "x": 0.5, "y": 0.5 },
    { "phase": "move", "x": 0.65, "y": 0.5 },
    { "phase": "up", "x": 0.65, "y": 0.5 }
  ],
  "expect": {
    "cameraChanged": false,
    "changedTransformEntityIds": ["entity:REPLACE_WITH_EXPECTED_MEMBER"],
    "unchangedEntityIds": ["entity:REPLACE_WITH_NONMEMBER"]
  }
}
```

这些 ID 和坐标是示意，必须替换为本次场景的真实 ID 和可见测试位置。
坐标是画布归一化坐标，左上 (0,0)，右下 (1,1)；命中点和法线是世界空间。
`state.entities` 的 transform 是父局部数据。若通过共同父节点旋转，子节点局部变换
可能不变，应检查父节点、层级和实际世界效果，不能要求所有子节点局部坐标都变化。
成员集合与旋转轴必须根据玩法计算，不能只让脚本绑定对象旋转后自报 `moveCount`。

工具在 `steps[].routing` 保留每一步的几何命中、pointer 订阅、捕获接收者、被过滤事件、
脚本读取记录和 OrbitControls 的接管/避让决定；`diagnostics` 给出首次可定位的故障阶段。
优先修复最早断开的阶段：

1. `background-hit`：down 没命中不透明网格。确认测试位置、相机和目标可见性；这可能是正常背景操作。
2. `pointer-unavailable`：命中物体缺少/禁用 pointer。检查实际可见外表面，不能只给被遮挡的内部面加组件。
3. `events-filtered` / `event-limit`：核对 events、draggable、capturePointer 和 maxEventsPerTick。
4. `events-unread`：核对脚本绑定与读取范围。`selfInteractions` 只匹配脚本自身 ID，子对象事件不会冒泡。
5. `read-without-entity-effect`：脚本读到了事件，但实体未变化。读取不证明分支执行；检查事件过滤、阈值、状态保存与实际修改目标。
6. 已有变化：核对完整的预期成员/非成员、相机和规则状态，不能只看计数器或截图存在。

`background` 模式按几何命中避让，不依赖是否订阅 down；无 pointer 的不透明表面也不是背景。
装饰面需要穿透时，显式配置 `penetrable:true`。`all` 模式仍表示拖拽整个画布控制相机。
结果过大时 `stepsRoutingTruncated:true` 表示返回的逐步路由已缩减，完整有界记录仍保留在手势证据中。诊断标为 `routing-incomplete` 时，说明旧运行时或数据截断，不能断言“没有命中/没有脚本读取”。

同任务、同文档修订和脚本版本的相同预期连续失败两次，继续相同测试会返回
`interaction.diagnostic-required`。先检查命中对象和脚本，再修复；若要验证另一原因，
使用不同 points/expect 并提供 `hypothesis` 说明预期区分什么。仅换截图、tick 或重新开 Play 不是进展。
记录在当前工具运行实例内有界保存，应用重启后重新计数。

最终手势 state 证据使用 `effects.cameraChanged` 等路径；没有 `gesture.final.effects` 包装。
`diagnostics.expectationMatched` 只是显式预期的逐项数据比较，不自动代表整项玩法或视觉验收通过。

`effects.changedTransformEntityCount/Ids` 单独报告父局部 position/rotation/scale 的变化，排除仅材质变化和脚本自报指标。它只证明变换发生，旋转轴、角度和完整成员集合仍需按实际玩法检查。

验收计划的 `acceptance[].assertion` 优先使用结构化比较，编辑器在批准前生成 DSL：

```json
{"type":"state","signal":"effects.cameraChanged","operator":"equals","expected":false}
```

`operator` 和 `expected` 都不可省略。`effects.unchangedEntityIds` 不存在：
`unchangedEntityIds` 是手势工具 `expect` 输入。验收未移动对象应比较实际证据中对应对象的
位置/旋转等值，保留预期对象和完整要求；不能用 JSON 修复器猜测缺失的判断条件。
