# Appearance-first composite authoring

用户的“圆角、六面不同颜色、有轮子的车、有边框的按钮”等描述通常是可见结果，不是一个 primitive 的实现要求。显式要求使用某种 API、资产或建模方法时才视为实现约束。轮廓、材质区域、可动部件和交互区域都应在方案中保持可追踪。

## Built-in workflow

固定 prompt.workflow.general-authoring 负责每次创作都遵守的原则；可检索的 composite-object-authoring 指南负责详细步骤；prefab.manage 的说明把这些原则连到已有操作。这是 AIStudio 内置、provider-neutral 的创作工作流，不是给 Codex 安装的技能，也不依赖魔方关键词。

1. 列出外观要求与显式实现约束。
2. 按轮廓、独立材质区域、运动自由度、交互职责分解部件。一个物体可由多个 mesh 组成；几何的圆角不提供独立面颜色。
3. 确定根节点、局部原点、部件的 parentId/局部 Transform、材质和运行时运动 owner。根节点带非单位缩放时，子节点也会继承该缩放。
4. 通过 entity.create/create-many 创建一个完整样件；component.configure 配置拾取与其他组件。验证多个视角、真实变换以及子部件跟随。
5. prefab.manage(action=capture) 捕获根节点子树；instantiate 复制完整组合，使用返回的 rootEntityId/instantiatedEntityIds 配置每个实例。对重复部件使用受限工具批次，遵守 revision 和依赖关系。
6. 回归材质区域、部件数量、偏移、朝向、共同运动、保存重开及 Play；不要把 HUD 计数增加当作物体真的运动。

现有 prefab 是项目中的快照复制，不是实时联动资产。实例使用新实体/组件/脚本 id，但脚本文本中硬编码的 id 不会重写。应把公共控制逻辑留在独立 controller，或使用实例自身和明确绑定；不要认为单一 mesh 的 api.scene.instances 会复制整个子树。

## Examples and local coordinates

- 骰子：本体＋各面的点数标记。
- 车辆：车身＋独立转动的轮子。
- 柜子：柜体＋有铰链原点的门。
- 魔方小块：深色圆角本体＋六个独立圆角面片。复用 27 次后按位置隐藏/省略内部面片，标准三阶共 54 个外露色片。色片跟随所属小块的姿态，不绑定固定世界方向。

单位本体范围 [-0.5, 0.5]。面片可以使用 rounded-box(radius=0.1, segments=4)，将 Transform.scale 设为 (0.85,0.85,0.02)，局部 position.z=0.505。其他面选择对应法线轴的薄缩放及正负偏移；每片有自己的材质颜色。先生成有圆角轮廓的几何，再沿法线压薄；仅减小几何厚度可能让引擎将 radius 限制到厚度的一半。保持面片外侧略离本体，避免深度冲突。上述尺寸是单位样件示例，不能用作屏幕到世界的固定比例。

## Evidence and current limits

play.capture 从同一 JS 执行任务复制当前状态与像素，再异步编码 PNG；返回 observations 中的 screenshot/state/event-trace/runtime-errors/performance 使用同一 tick。task.evaluate 应使用该 bundle，不能拼接早先的 inspect 状态与后来截图。保留跨任务、版本、设备和 viewport 校验。

时间不匹配/可重新采集的旧版本证据只能进入既有有限 repair budget，不会变成通过。跨任务等 provenance 错误保持终止。回合结束保留具体 diagnostic。

api.scene.observe 的项目状态位于 gameplay[index].value；先 inspect 实际路径再 evaluate。当前 performance 包含 finite/tick/frame/timeMs，不是 FPS 测量；当前无生产 visual-analysis 验证器。计划提交时拒绝这两类无法生产的断言，并给出字段说明；不能将截图存在或脚本自报的布尔值当作视觉正确性证明，也不能删除用户需求来规避校验。

后续工具的优先方向是通用 assembly authoring：有稳定部件角色的层级定义、受限参数/材质覆盖、批量 instantiate、实例 id 映射及原型结构检查。它应复用当前 Document/History/prefab 存储和权限流程，不应新增魔方专用 createRubikCube 工具。当前变更没有引入新的 prefab 格式或宣称已具备实时联动、任意参数化、批量实例化 API。
