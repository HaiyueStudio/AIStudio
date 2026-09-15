# 交互故障诊断与修复机制

状态：通用诊断与修复反馈机制已实现（2026-09-15）。下文保留调查事实与设计依据；实现范围和验证见本节。

## 已实现的范围

- Preview 在 tick 内记录几何命中（包括无 pointer 的遮挡网格）、世界命中点/法线、订阅/捕获/限流结果、global/self 脚本读取和 Orbit 决策；停止时清理，不生成逐帧持久日志。
- background Orbit 使用 Engine 公开 raycast 的原始命中避让；不再依赖订阅后 down 事件。拾取异常也不会被当作空白。all 模式保留整画布相机控制。
- play.pointer-gesture 在 settle 前保留逐步路由，返回首次可定位阶段、下一步检查方向和显式 expect 的结果；期望可检查实际变换成员、其他变化成员、保持不变成员及相机。读取事件不等于执行分支；变换变化也不等于轴/角度/玩法正确。
- effects.changedTransformEntityCount/Ids 排除仅材质变化；缺失/截断证据明确标记。路由按步、按结果字节有界投影，完整有界证据仍存储在最终手势 artifact。
- 相同任务/文档/修订/脚本版本的相同显式预期失败两次后，继续测试必须修改候选，或用 hypothesis 解释不同 points/expect。此检测在当前工具实例内保留、最多 64 个键；应用重启后计数重置，仍保留任务时间线和证据。
- 诊断保留在压缩模型结果、任务时间线、修复/检查点续跑上下文；第三次无进展错误进入既有受预算约束的工具纠错流程，不自动扩权、不重放编辑。
- 已知 gesture.final.effects 包装仅在计划批准前规范化；已批准的错误路径被识别为不可用信号，不通过修改游戏或悄悄重写验收来掩盖。

边界：未修改用户当前生成项目，没有实现通用的脚本分支追踪、自动世界矩阵验收或魔方专用求解器；实际成员选择/旋转算法仍由 agent 根据真实对象数据完成。只报告脚本读取和真实状态变化，不声称已覆盖所有玩法语义。旧运行实例需重启 AIStudio 才能使用新 runtime。

验证记录见 `../evidence/interaction-repair-20260915/README.md`。

## 最近一次魔方记录中的事实

调查对象是最近活动项目的本地历史，document revision 11；它与磁盘上较早保存的 mofang 项目不是同一个 document，不能用旧保存文件代替当前运行记录。

- 最后一次 script.apply：2026-09-15 07:43:56 UTC，r10 → r11。
- 之后完成了 10 次 play.pointer-gesture、8 次 preview.validate、4 次 play.start、4 次 task.evaluate、5 次 play.capture、10 次 project.snapshot；这 10 次拖拽测试的修订全部是 r11，没有新的 script.apply。
- 08:11:55–08:12:25 UTC 的测试包含视口中心 (0.5, 0.5) 向右拖拽，以及 (0.5, 0.62) 向右拖拽。返回 interactionCount=0、interactionTargetId=null、effects.cameraChanged=true、effects.changedEntityCount=0。
- 新增的 pointer 组件绑定到 Rubiks Cubie · face-front。其父小方块的 position=(0,0,0)，面片局部 position=(0,0,0.471)。在 3×3×3 组合中，这是中心小方块的内侧面，不是外部可交互表面的完整配置。组件开启了 down/move/up/drag/cancel、capturePointer 和 draggable。
- 生成脚本已经调用 api.scene.orbitControls({mode:'background'})，并读取全局 api.input.interactions()；因此这次不是简单的“漏写 background”或“把 selfInteractions 放在 camera 上”。
- 生成脚本收到 up 后只比较世界命中点差值，然后增加 moveCount，并对 entity 自身做 Y 轴 90° 旋转。它没有根据命中小方块选出一层、计算旋转轴、同步层内成员的位置/方向和离散格坐标。
- 最后一次 evaluator 还报告 evaluation.signal-missing:gesture.final.effects.cameraChanged；实际生产字段是 effects.cameraChanged。这是验收数据路径错误，需要和实际玩法缺陷分开处理。

上述事实说明，现有 agent 在缺少输入事件时继续重试验收，且用局部状态计数替代完整玩法实现。截图和更高修复次数不能替代故障定位。

## 现有实现的诊断缺口

- apps/ai-studio/src/preview-runtime.ts 中 updateInteractions 先做 Engine raycast，再按组件 events 过滤。返回给工具的 interactionTargetId 来自过滤后的事件。null 无法区分“没命中可见物体”“缺 pointer 组件”“事件被配置过滤”“命中异常”。
- apps/ai-studio/src/play-orbit-controls.ts 的 background 模式根据是否存在 down 事件避让物体。在其他项目中，如果 pointer 组件没有订阅 down，就可能把物体当成背景。这是额外发现的风险；本次记录中的组件已经订阅 down，不能把它当作本次已证明的根因。
- packages/game-authoring-tools/src/runtime.ts 的 play.pointer-gesture 已提供 host 计算的 effects 和逐步 interactionTargetId，但没有命中/路由/脚本读取链路的诊断报告。
- packages/agent-orchestration/src/task-acceptance.ts 的 repairRequest 只提供失败标准、证据 ID 和一般性建议。“不要重复修复”目前主要是文本约束，没有根据故障阶段强制切换诊断方式。

## 建议实现顺序

### 1. 扩展现有手势工具的证据

复用 play.pointer-gesture，不要求模型先发现一个新工具。每次测试产生同 Play、同 revision 的有界诊断，区分以下层次：

1. 输入：注入的坐标、pointerId、阶段、tick；坐标均为预览视口归一化坐标。
2. 命中：几何命中对象、可交互目标、世界命中点/法线、候选是否缺少或禁用 pointer 组件。
3. 路由：配置允许哪些事件、实际发出哪些事件、捕获对象、截断/限流/异常原因。
4. 消费：哪些脚本实际读取 interactions/selfInteractions、返回了哪些实体的事件；读取并不证明脚本分支成功。
5. 相机：OrbitControls 的 owner/mode，以及接受/避让该手势的原因。使用命中所有权而非可订阅事件列表决定背景避让。
6. 效果：按目标范围比较真实 Engine transform/material/camera；模型自报的 observe 指标只作辅助。

额外 raycast 必须复用 Engine 的公开拾取能力；不得由模型或编辑器重新实现射线算法。诊断使用内存有界缓冲，仅在测试/inspect 时形成 artifact，不把每帧 pointermove 全量写入 operation log。明确未知和截断，不能把数据缺失断言为功能缺失。

### 2. 先定位第一处失败，再允许修复

控制器根据证据产生下一步：

- 无交互事件：先核对测试坐标与实际可见目标、pointer 配置和层级；停止修改旋转数学。
- 有命中但无分发：检查订阅、capture、draggable、过滤/限流。
- 有事件但脚本未读取：检查脚本启用、绑定实体、capability、self/global 范围。
- 脚本读取了事件但无物体变化：检查条件分支、目标引用、动画推进与其他写入者覆盖。
- 物体与相机同时变化：检查输入所有权冲突。
- 物体有变化但不符合需求：验证成员集合、轴、角度和规则。
- evidence signal missing / id mismatch：进入证据协议修复，读取生产字段及标准绑定；不修改正确玩法、不重复截图、不静默弱化已批准标准。

每次修复保留“假设、支持它的证据、区分假设的最小探测、实际修改、同手势复测结果”。下一轮获得这个小记录及失败链路涉及的对象/脚本，不需要全场景快照。

### 3. 对重复无进展强制换策略

故障签名包含标准、故障阶段、目标、document revision、script digest。不要包含每次都变化的 tick、截图 hash 或新 artifact id，否则重复测试永远被当成新进展。

同一签名连续出现时切到诊断阶段，要求新探测能排除一个具体假设，或修复产生新的相关修订。限制重试而非禁止有理由的对照实验；对照实验必须记录目的和预期差异。原有预算、审批和失败证据继续保留。

### 4. 对交互建立可验证的行为约束

计划明确输入对象、接收者、受影响对象集合、预期变化与必须保持不变的对象。

魔方示例：

- 外侧方块拖拽：命中该方块；选择正确层；层内 9 个小方块的整体位置/朝向按规则更新；相机不动；其他层不动。
- 空白拖拽：相机变化；所有小方块保持不变。
- 同层同向转四次：离散格坐标和朝向恢复；结构/材质引用不损坏。

应比较成员整体状态：位于旋转轴上的中心成员位置可能不变，不能要求每个成员的每一个字段都改变。是否显示动画还需观测中间 tick；外观才使用截图。

这些约束同样适用于棋子拖放、物品拾取、拖拽排序、角色移动和相机控制，不应在通用运行时硬编码魔方规则。

## 回归要求

使用真实 Engine/预览路径注入缺失 pointer、禁用 down、父子接收者不一致、错误 motion owner、Orbit 抢占、仅自报成功、动画未推进等缺陷。每个缺陷都应定位到正确阶段；修复后同一手势通过，背景对照也通过。正常空白拖拽不能被误判为错误。

另测中心/边角、相机变化、窗口缩放、不同投影、长日志下的诊断截断、停止/重启清理、旧 evidence 路径错误与旧审批兼容。诊断不得改变标准、提高权限或伪造通过结果。
