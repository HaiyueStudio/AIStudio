# Appearance-first composite authoring

用户的“圆角、六面不同颜色、有轮子的车、有边框的按钮”等描述通常是可见结果，不是一个 primitive 的实现要求。显式要求使用某种 API、资产或建模方法时才视为实现约束。轮廓、材质区域、可动部件和交互区域都应在方案中保持可追踪。

## Built-in workflow

固定 prompt.workflow.general-authoring 负责每次创作都遵守的原则；可检索的 composite-object-authoring 指南负责详细步骤；assembly.create / inspect / instantiate 把这些原则连到原有 Document History 操作。这是 AIStudio 内置、provider-neutral 的创作工作流，不是给 Codex 安装的技能，也不依赖魔方关键词。

1. 列出外观要求与显式实现约束。
2. 按轮廓、独立材质区域、运动自由度、交互职责分解部件。一个物体可由多个 mesh 组成；几何的圆角不提供独立面颜色。
3. 确定根节点、局部原点、部件的 parentId/局部 Transform、材质和运行时运动 owner。根节点带非单位缩放时，子节点也会继承该缩放。
4. 在方案 assemblies 中声明 assemblyId、label、partKeys、distinctColors（需要颜色分区时）及 minimumInstances。用 assembly.create 的 blueprint 一次创建完整样件；每个部件声明 key、可选 parentKey、kind、局部 transform、material/color 和可选 colorSlot。requirements 把外观要求对应到实际 partKeys。component.configure 配置拾取与其他组件。验证多个视角、真实变换以及子部件跟随。
5. assembly.inspect 从真实文档核对结构，返回 prototypeDigest；assembly.instantiate 使用该摘要和根节点 placements（instances 数组）批量复制，可按 colorSlot 覆盖颜色。原型本身是第一个可用实例，要得到 27 个只需额外复制 26 个。复制前重新检查原型，失败时不写入任何实例。复制保留原型的指针等已配置组件，并重映射内部实体引用；脚本放在组合外部的共享 controller，避免复制后硬编码 id 仍指向原型。带脚本的原型会明确拒绝复制，不会静默丢弃脚本。使用返回的 rootId/partIds 绑定运动及交互。旧的已建子树仍可使用 prefab.manage。
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

## Enforcement and resource ownership

批准方案中的 assemblies 随原有 plan 内容持久化，恢复后继续执行。声明组合方案时，大批独立几何体不能替代组合实例；灯光批次和辅助单实体仍可创建。进入 preview.validate / task.evaluate 前检查方案要求的部件、实际颜色分区及实例数量，不能仅靠脚本自报计数通过。未声明组合的旧项目继续可用；不根据游戏名强行猜测结构。

组合蓝图及实例绑定存放在版本化项目 setting `studio.assemblies.v1`，使用既有 History batch；保存、撤销、重做一起处理。原型修改后旧摘要失效；不完整原型不能复制。实例当前是结构快照，变更蓝图不会暗中同步所有实例。模型必须保留每项用户外观要求；结构检查不能自动推导未声明的需求，也不能证明可见性或审美质量。

相同规范化参数的几何体在同一个编辑/预览投影中自动共享 Engine Geometry 对象。名称、位置、缩放、颜色不参与几何身份；半径、分段、平面方向参与。不同投影独立持有缓存，释放或重建不销毁其他实例引用的几何体。材质定义按完整配置聚合，运行时仍保留实例可变参数，避免改变一个对象使其他对象串色。此机制不承诺 GPU draw-call instancing。

资源面板按定义摘要聚合，显示使用数及可跳转的位置。单个对象修改几何参数形成另一资源定义，其他对象保持原定义；重命名不会改变资源身份。大量使用位置有显式截断提示，避免列表结果挤占上下文。

## Tool example: a reusable two-sided sign

在方案中声明：
```json
{"assemblies":[{"assemblyId":"sign","label":"两面独立颜色的标牌","partKeys":["body","front","back"],"distinctColors":3,"minimumInstances":10}]}
```

assembly.create 的 blueprint 将外观要求对应到部件。body 使用深色圆角盒；front/back 使用同一个圆角几何定义，分别设置局部 z 为 ±0.505、scale 为 [0.85,0.85,0.02]，以及红、蓝两种颜色和不同 colorSlot。Transform 对象使用 position / rotationDegrees / scale，每个向量是 {x,y,z}；这些是父节点局部坐标，不是屏幕坐标。parts 父节点先于子节点声明，省略 parentKey 时挂到自动创建的共同运动根。

requirements 示例：`[{"label":"主体与前后独立色板","partKeys":["body","front","back"],"distinctColors":3}]`。

随后调用 assembly.inspect({baseRevision,assemblyId:"sign"})，修复 problems 并检查预览角度；将返回的 prototypeDigest 直接填入 assembly.instantiate，传入 9 个额外 instances，每项提供 name、根 transform 和可选 colors（键是 colorSlot）。轮子、门、装饰条同样使用部件角色及父子关系表达，不新增游戏专用工具。


实例交互检查：`assembly.inspect` 和方案预览检查会核对副本的指针配置。必须在复制前完成原型交互配置，或逐个修复检查报告中的既有实例 id。可见面片应明确选择“发出命中事件并映射到共同运动根”或“可穿透装饰”；不能因为 interactions 为空就直接把物体拖动判成背景。`api.read.findAll(name)` 是名称完全匹配，不识别 part key；保留 rootId/partIds 绑定，并验证真实的分组运动与相机不变。详见 pointer-picking 指南。
