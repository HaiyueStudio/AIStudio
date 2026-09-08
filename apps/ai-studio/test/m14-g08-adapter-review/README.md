# M14 G08 既有适配器复核

本轮复核 G05 首版行为流程，新增运行时适配器为 **0**。初始 G01 阻断项选择为空；2026-09-08 的真实窗口复核发现并修复 **1 个既有截图路径缺陷**，已按原 changeControl 由串行集成 owner 记录到 [首版清单](../../../../config/contracts/m14-capability-first-release.json) 的 `g08.review/selected`。未改变 G01 历史 Goal 或扩展高级能力批次。

## 缺陷与修复

零脚本和混合项目在暂停、步进、调整窗口后，屏幕上的模型和 HUD 正常，但原 `play.capture` 返回全透明 PNG。原测试只核对 PNG 格式、字节数、tick，没有验证画面内容。复现时窗口截图与导出 PNG 对照、独立 PNG 解码均确认了缺陷；隔离诊断表明延迟复制已呈现的 WebGPU 画布会使截图合成失去内容。

现有 `play.capture / adapter.ui.hud` 路径现在在实际渲染任务内保存一张有界画面，延迟截图从该画面合成 HUD，不推进模拟。仅保留一个受现有预览像素预算约束的画布；不变尺寸时复用，Stop/重启将其尺寸清零并释放引用。既有 disposableCount 继续表示脚本副作用；截图存储按 Play 生命周期独立释放。异步编码开始时固定 tick/frame，结束时校验 Play 代次，停止后的迟到图片被拒绝。首次尚未渲染时明确拒绝截图。暂停后仅改变尺寸、未继续渲染时，截图按新尺寸呈现最后一帧；本轮窗口验证在 resize 后显式步进，证明新尺寸下的实际渲染。

没有增加公共 API、GPU/DOM 暴露面、组件版本、资源格式、工具或提示词。所有原通用工具、审批、精确 revision 和 History 保持原路径。

## 复核清单

以下均为当前注册表的既有 `1.0.0` 组件。表格是本次审查范围，不是第二个注册表。`verify.mjs` 从真实注册表核对身份并输出实际版本、effect、schema 摘要及依赖包摘要。

| 组件 | 既有 adapter | 核对范围与证据 |
| --- | --- | --- |
| `haiyue.script.binding` | `adapter.script.binding` | `play.multi-script`；编译/审批/顺序/故障隔离，原纯脚本真实 iframe 回归及本轮混合轨迹 |
| `haiyue.gameplay.state` | `adapter.gameplay.state-observation` | `play.inspect`；状态 schema/序列化，真实 timer/input/trigger 引起的分数变化、HUD 和绑定 |
| `haiyue.gameplay.rules` | `adapter.gameplay.rules` | `simulation.fixed-step`；禁用/重复/once 语义，真实输入和计时器规则，混合物理规则 |
| `haiyue.gameplay.timers` | `adapter.gameplay.timers` | `simulation.fixed-step`；零脚本授权，固定 tick 触发、Stop 后重新计时 |
| `haiyue.ui.hud` | `adapter.ui.hud` | `play.capture`；本次唯一选中修复，真实 HUD/模型像素、resize、编码取消、重启 |
| `haiyue.audio.listener` | `adapter.audio.listener` | `audio.playback` 的既有监听器配置；真实 gain 投影、重复监听器拒绝、释放回归。不是音频源播放验收 |
| `haiyue.physics.world.2d` | `adapter.physics.world-2d` | `physics.2d` 必需依赖；真实 Box2D world、停止与重启 |
| `haiyue.physics.rigidbody.2d` | `adapter.physics.rigidbody-2d` | `physics.2d` 必需配对依赖；真实两刚体运行、清理 |
| `haiyue.physics.collider.2d` | `adapter.physics.collider-2d` | `physics.2d`；真实 trigger-enter、规则加分与来源轨迹 |
| `haiyue.animation.transform-clips` | `adapter.animation.3d-mixer` | `animation.3d`；公共 Mixer 改变实际 Transform，独立于物理实体，配置不可变 |

复核覆盖 schema/受控资产、JSON round-trip、未知版本拒绝、v1 迁移备份/回滚/重开、工具 effect 与精确版本、来源变更失效、生命周期。新窗口夹具通过真实项目工具创建并配置组件，通过真实校验器和一次性授权生成 PlayPlan，通过生产行为读服务绑定当前 registry 和 runtime bundle；直接加载生产 preview iframe。零脚本 `scripts=[]`，混合模式含一个真实编译脚本。两者都不写回 Document/History。

## 验证入口与适用性

在 AIStudio 根目录完成当前构建后执行：

```text
npm run build -w @haiyue/ai-studio
node apps/ai-studio/test/m14-g08-adapter-review/verify.mjs
npm run m14:capability:capture
npm run check
```

- `adapter-device.test.mjs`：两个真实窗口用例，分别覆盖两次运行、零脚本/混合、拒绝授权/一次性授权、JSON round-trip、原始 source binding、实际 timer/input/physics 轨迹、动画位置、HUD、resize 后新帧、模型/HUD 两类像素、停止清理、启动取消后重试、延迟截图取消、项目与 History 不变。每例限制 100 秒，seed 为 `haiyue-play`、60 Hz；本轮每次正常运行 20 ticks，不宣称已跑满 600 ticks 上限。有效 PNG 无原型替换；仅最后的取消用例注入 PNG 回调延迟以保证竞态可复现。
- 文档/工具：复用 `g05-document-v2`、`g08-render-asset-components`、工具 runtime/transactions/behavior 等实际回归。没有新组件版本，无需新增迁移；原 v1→v2 迁移完整回归。
- 运行生命周期：复用 `script-preview`、`play-simulation`、`g07-physics-runtime`、`g08-render-effects-runtime`、声明式与 G05 source/IPC 测试。纯脚本的真实多脚本故障隔离由原 `g09-multi-script-electron` 复验。
- device loss：原渲染 effect 测试使用明确的事件注入验证 lost/restored/释放，不能称为真实显卡故障恢复。新截图存储是随 Play 释放的画布，不新增 GPU 恢复参与者；真实窗口 Stop/重新初始化和 resize 在本轮覆盖。硬件失效与七类游戏的整体组合仍由正式集成验收负责。
- asset abort/audio unlock：本次选中截图没有新文件资产或音频源，不适用新增下载/解码/unlock 流程。原 asset-transfer 中止、迟到音频释放和 unlock listener 单测、受控纹理真实 iframe 仍作为回归执行，不据此升级其它资产/音频能力。
- 不能证明的 adapter 内部关系仍为 unknown；当前绑定和实际运行观测不能提升未观察路径或其它 35 项能力。

## 当前证据与 G09 交接

机器结果以 [checks.json](./test-output/checks.json) 和 [acceptance.json](./test-output/acceptance.json) 为准；原始结果包含耗时、测试数量、源码输入摘要、PNG 摘要、实际 OS/Electron/GPU/驱动以及 source binding。真实画面见 [零脚本](./test-output/zero-script-0.png) 和 [混合](./test-output/mixed-0.png)。完整检查输出保存在本目录 `test-output`。

G08 交付的是选中既有截图路径的独立 adapter-ready 修复及其余首版依赖的有限复核，**不认定 product-integrated**。G09 必须把本目录验证接入正式入口，并将当前候选包、工具、UI 和运行证据组合复验；已有 G06/G07 导出与接线交接保持。M12 G12 blocked、M13 G11 active 及其它 Goal 门禁不因本次改变。参数化几何、完整 GUI、专用格式、导航、存档、RTT/Compute 均未实施。
