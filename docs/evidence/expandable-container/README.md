# 通用放大容器与执行拓扑图

UI 新增 `@haiyue/ui/expandable`，导出 `HYExpandable`、`defineExpandableComponents` 和配置/事件类型。
`hy-expandable` 支持 `expanded-width`、`expanded-height`、四角 `button-position`、可本地化的
`expand-label` / `restore-label`；内置 SVG 可通过 `expand-icon` / `restore-icon` slots 覆盖。
公开 `expanded`、`expandedWidth`、`expandedHeight`、`buttonPosition` properties 和 `toggle()`；
`expanded-change` 通知状态变化。配置示例和 CSS tokens 见 UI README 的 Expandable container 一节。

展开使用 fixed + Popover top layer，在 overflow/transform 祖先内仍按视口显示；宽高受视口边距限制。
默认 slot 的 DOM 不移动、不复制；输入、canvas 和已有监听器保留。按钮提供 ARIA 状态和键盘操作，
Escape 还原有焦点的容器；断开时清理顶层面板与文档监听器，重连可恢复 expanded 属性。

AIStudio 的拓扑图使用 96vw × 94dvh，右上角放大/还原。流式重绘和工具栏重绘保留展开状态；
ResizeObserver 重算适应视图，手动缩放则保留比例。应用通过公共候选包消费组件。

候选包以 `haiyue-ui-0.1.3-scrollable-tabs.tgz` 为基底，仅增加新组件和公开导出、版本与说明，
保留其余现有模块字节。完整叠加 diff 位于 `vendor/patches/ui-expandable.patch`；来源及 integrity
位于 `config/upstream/ui-candidate.json`，其中 `baseCandidate` 保留此前滚动 tabs 等修复的来源。
不以 UI 仓库较旧的整体包覆盖产品的已修复模块。该候选包仅供本地接入，未发布 npm。

## 验证

- UI：`npm run typecheck`、`npm test`（23 项）、`npm run build` 通过。
- 应用与 shell 构建通过。
- `expandable-electron.test.mjs` 在真实 Electron 窗口验证固定尺寸、四角位置、SVG slot、ARIA、
  原生鼠标/键盘、断开重连、内容生命周期、流式更新、工具栏重绘、窗口尺寸变化及还原。
- 新增测试已注册在正式集成清单和能力捕获检查组；原始输出与截图随本目录保存。

未重启或重载用户正在运行的 AIStudio，未修改用户游戏。完整仓库检查结果以本目录日志和最终记录为准。

最终正式能力捕获：132 项通过，绑定当前源码与候选包。
总检查曾在旧能力记录失效处停止；刷新后单独校验其一致性。本轮未重复运行总检查后续所有阶段，
不声称全仓检查全绿。UI 专项与三项真实拓扑图回归全部通过。
