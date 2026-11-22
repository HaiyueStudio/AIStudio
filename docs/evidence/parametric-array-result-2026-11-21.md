# 参数化阵列实现与验证

日期：2026-11-21

已接通通用的 `scene.populate`：`entities` 模式一次创建独立格子，`instances` 模式以一个实体保存配方并使用原生 GPU 实例。支持 XY/XZ/YZ 行列、间距、模板几何/材质、旋转缩放、seeded palette，复用 arrayId 扩缩容或切换模式。设计与示例见 [ADR](../adr/0005-parametric-scene-arrays.md)。

- 编辑态无需初始化脚本即可显示；实例可选中整组并跟随根/父节点变换。普通检查器和材质入口使用同一持久化组件。
- 创建、配方编辑、派生格子及模式转换共享一次 Document/History 事务。Undo/Redo 恢复已有手工位姿。扩缩容保留格子 ID，删除遇到独立数据或引用时原子拒绝。
- 保存重开与编辑器重载保留配方。Play 使用 api.scene.instances(rootEntityId) 获取配方容量，脚本可接管位置/颜色；Stop 清理资源。
- 两后端均通过实际 adapter、工具发现、批准计划、自动审批和真实 Document/History 路径测试；provider transport 使用本地 fixture，未调用付费在线模型。
- 七类游戏检索保持全部成功，并保留原 schema 数量预算。碰撞规则先走组件配置，明确的运行检查优先保留 play.inspect。

| 验证 | 最终结果 |
| --- | --- |
| 完整能力采集 | 19 组 / 386 项通过，无跳过 |
| 阵列专项组 | 24 项通过，含真实 GPU / 隔离 Play |
| Harness / Codex × 两种模式 | 4 条路径通过，纳入全量工具检查 |
| 注册表 | 45 个组件 / 59 个工具 |
| npm run check | 前置检查全部通过；86 个集成文件，517 项通过、1 项失败，无跳过 |
| GPU 证据 | 编辑态/重载/Play 均为 400 实例，修改后的白色实例真实渲染，Stop 后 disposableCount=0 |

全量检查唯一失败仍为既有冻结硬件断言：要求 i7-7700 / 8 线程，当前为 i7-14700KF / 28 线程。未修改基准条件，未推进里程碑验收。

收尾时修复了审批屏障测试的一处时序断言：在调用释放后等待执行图真正投影为 waiting，再断言；全部原断言保留。

当前输入摘要：`sha256:e4a6cd79085096533fcf5c01e7b13ee3d2c6b9cc088c12e08d0e05648df799d7`。机器可读结果见 [JSON](parametric-array-result-2026-11-21.json)。本次生成的截图、TAP、结构化记录及 SHA-256 清单位于 `.cache/parametric-arrays/integration-output`；历史受控 test-output 已恢复，源代码和既有未提交修改均保留。
