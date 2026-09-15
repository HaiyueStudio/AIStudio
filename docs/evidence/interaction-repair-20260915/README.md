# 交互诊断与修复回归（2026-09-15）

本次修改通用 Preview、手势工具、修复反馈和文档，不修改用户当前项目。

## 验证

- Game authoring tools、Agent orchestration、AIStudio 构建通过。
- 最终工具专项：14 项通过（`tools-tests.log`）。包含命中/事件/读取阶段、真实变换与仅变色区分、旧 evidence 包装、同版本重复失败与新假设、settle 后保留诊断、400 对象场景，以及 32 点/40 脚本/50 对象变化的 64 KiB 返回预算。
- 最终 host/app 专项：34 项通过（`host-tests.log`）。包含 Orbit 所有权、拾取异常避让、tick 清理、读数边界、任务历史与续跑、压缩后的失败反馈、审批和预算约束。
- 真实 Electron + Engine 回归通过（`electron-tests.log`）：40 次点击覆盖中心/四角、相机移动、窗口缩放、正交/透视；另覆盖 native/synthetic 拖拽、同 tick 完整手势、捕获、子面到组合体、无 pointer 遮挡面、click-only 表面、穿透装饰面、空白相机拖拽、增量点击改色。
- 本机沙箱内 Electron 启动被系统终止，无测试结果；使用独立授权测试窗口复跑成功，没有关闭正在使用的 AIStudio。
- `engine:docs:check` 通过（18 项）。交互故障指南拆为独立、默认预算可读取的文档，原数据验收指南也保持可读取。
- `git diff --check` 通过。

## 整仓限制

运行 `TMPDIR=/private/tmp npm run check`，停在 `m14:capability:check` 的既有验证输入绑定过期检查，错误为 `stale verification input binding`。未重新采集或绕过 M14 基线。完整输出见 `root-check.log`，不能宣称整仓检查通过。

## 行为边界

- `expect` 只诊断当前测试，不代替或降低批准后的验收条件。
- `changedTransformEntityIds` 证明父局部变换发生；轴、角度、层成员、世界效果和视觉仍需按任务验证。
- 读取事件不是成功执行处理分支；截断或旧版运行时数据缺失不能当作“无事件”。
- 重复计数在当前工具实例中有界保留，应用重启后重置；历史诊断和实际修订保留在任务记录。
- 新运行时需重启 AIStudio 生效；现有错误生成脚本需使用新诊断再修复。
