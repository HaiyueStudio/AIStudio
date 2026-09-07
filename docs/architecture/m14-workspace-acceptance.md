# M14 G03 独立验收记录

日期：2026-09-07。范围是消费 G02 冻结合同的逻辑/资源工作区、现有高级手动入口和布局回滚。用户显式启动 G03；G02 已完成，M13 G11 active、M12 G12 blocked 与后续 Goal 门禁保持原状态。

当前状态：G03 独立验收完成。当前工作区输入绑定：`sha256:84d67d0759baa21ba6e13cbff4f0211069312f9adc0fbaabe3e08eca6af00ef7`，来自 [当前能力检查记录](../../config/contracts/m14-capability-verification.json)。G01/G02 的历史验收摘要未重写。

## 逐项验证

| 要求 | 实现与证据 |
| --- | --- |
| 左侧逻辑/资源，完整高度视口 | [IntentWorkspace](../../packages/studio-shell/src/workspace/workspace.ts) 重用原面板；实际产品 smoke 检查空间位置与资源归属，新布局测试检查 desktop 几何关系 |
| 三类来源、事件入口与冻结位置合同 | 测试通过 G02 `BehaviorReadService.analyze` 分析固定混合来源项目，再展示 script/component/adapter 来源。实际点击发出的 EditorLocation 交回同一服务，三类均 resolve 为 current；事件仅来自真实 triggers |
| 过期、不完整和未知状态 | 文档修订不符、跨项目切换时清空来源、事件与目录；旧按钮不能继续定位。无分析时明确 pending；未知依赖/使用、不适用 unused 和不可用 preset 均不冒充完成 |
| 分类与四种 kind 分离 | geometry/lights 分开；asset/template/preset/instance 分别筛选并保留原引用与允许操作；不可用条目没有操作按钮；原手动资源入口节点与监听保持 |
| 可用高级入口与原写入路径 | 实际产品从高级面板调用原 Transform 提交，随后 Undo/Redo、保存、重开验证；提交后的真实脚本可在高级脚本入口读取；进入 Play 关闭抽屉，退出后恢复编辑视口 |
| 偏好迁移、经典回滚与销毁 | 经典 split.v2 比例保留，新模式独立偏好；损坏/超长/未知版本/受限存储回退；真正 reload 后检查持久化模式和分类；旧 DOM 归属恢复及重复 dispose 通过 |
| 键盘、ARIA、中英文与窄屏 | ArrowRight 切 Tab 并更新焦点/ARIA；真实键盘 Tab 保持在原生 modal，Escape 关闭并恢复焦点；中文/英文切换；900 与 375 像素布局和抽屉无页面横向溢出 |
| 1 / 100 / 1000 entity | 实际 Chromium DOM 渲染、过滤、选择；1000 个对象生成 1001 个 select options（含空选项），模型文本按字面呈现，未生成 HTML；测量见 [result.json](./m14-workspace-evidence/result.json)，是单机样本而非通用性能保证 |
| 既有选择、Agent、History、Play | 产品 smoke 验证 viewport 选中对象同步左侧，原 Agent 对话与推送同步、后端状态、精确修订 History、脚本授权、独立 Play、暂停/恢复、热重载、故障回收和两次加载。新统一行为定位的产品编排仍由 G05 接入 |

## 检查记录

- 新增布局/偏好与既有布局断言：4 项通过。
- 真实 Electron 产品 smoke：1 项通过，覆盖完整流程及 reload；总时限与原功能断言保留。新增抽屉等待改为检测实际可见，暂停稳定性按经过时间检查，避免固定重绘帧等待占满隐藏窗口的总时限。
- 类型、模块边界、合同检查：通过；合同为 53 schemas，53 valid / 82 invalid fixtures。
- `npm run m14:capability:capture`：完整构建后 9 组、78 项通过，35 capabilities / 44 components / 47 tools，product-integrated 仍为 0。
- milestones `npm run check`：通过；另外核对 9 个 Goal 与 14 条依赖均按编号向后执行。
- AIStudio `npm run check`：全部通过，包含合同、类型、边界、上游/候选包、协议、58 项既有 quick gate、current census、24 项 G02 回归与 5 项工作区/真实窗口验证，均无失败、取消或跳过。

## 视觉检查与边界

已人工检查实际产品 smoke 的完整截图，确认左侧工作区、中部真实 WebGPU Cube、右侧 Agent 与高级入口。归档截图为使用产品 HTML/CSS 的隔离布局测试宿主，含测试标识，不作为真实项目行为已接线的证据：[桌面](./m14-workspace-evidence/workspace-desktop.png)、[高级抽屉](./m14-workspace-evidence/workspace-advanced.png)、[375 像素](./m14-workspace-evidence/workspace-375.png)、[经典布局](./m14-workspace-evidence/workspace-classic.png)。

应用目前只提供现有实体、选择、脚本与组件的展示投影，行为与完整目录显示尚未就绪。G05 接入真实行为与版本定位，G06 补齐目录工作流，G07/G09 继续高级面板与组合验收。本次不升级能力矩阵的正式 product-integrated 状态，也不改写 G01/G02 历史证据。接线与回滚说明见 [工作区说明](./m14-workspace-shell.md)。
