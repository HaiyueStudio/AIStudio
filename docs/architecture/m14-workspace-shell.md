# M14 逻辑 / 资源工作区

G03 提供布局、来源展示与高级手动入口。真正的项目行为分析、定位及 Play 轨迹由 G05 装配，资源工作流由 G06 接入。共享合同沿用 [G02](./m14-behavior-contracts.md)，本阶段没有增加 Document、History、工具注册表或定位权限。

## 所有权

`@haiyue/ai-studio-shell` 的 `IntentWorkspace` 接收 `WorkspacePanelSnapshot`，通过 `WorkspacePanelPort` 发出选择、定位和资源操作意图。这些是呈现端口；行为来源、资源身份与位置直接引用 studio-contracts 的 V1 合同。调用方负责在边界验证数据，并提供同一项目版本的不可变投影。面板不执行工具、不读写项目文件，也不生成资源目录或行为关系。

应用 renderer 只组装既有 Scene/Selection/Script 投影和选择回调。实际编辑器当前传入空的行为绑定、manifest 和 catalog，明确显示尚未就绪。实体脚本和组件来源标记来自已有项目状态，不把组件存在等同于执行过某种行为。测试宿主单独使用 G02 的真实分析结果验证来源显示和位置合同，不把测试注入当作产品流程。

当前绑定与 manifest 的项目、文档、修订和摘要一致时才展示事件。事件入口只取 manifest 的 triggers；另外按脚本、组件和 adapter 来源展示只读位置。代码范围、组件版本和字段、adapter 版本和摘要均保留。旧投影、项目切换和销毁会撤销旧按钮及迟到错误的呈现资格；来源定位最终仍由项目服务校验。

分类与资源 kind 是两个独立筛选维度。四种 kind 原样保留，未知依赖/使用、不适用 unused 和不可用状态可见；不可用条目不提供操作。目录尚未接入时保留原有几何、灯光、材质、纹理、模型和脚本入口；这些旧入口尚未标注完整资源身份，所以只在“全部种类”下显示。

## 布局与回滚

默认布局为左侧逻辑/资源、中间完整高度的视口、右侧原有 Agent/执行记录/日志。高级编辑抽屉移动原层级、属性和脚本控件，保留原节点、事件监听及受控 History/授权路径。脚本资源卡也能打开高级脚本入口。进入 Play 会关闭抽屉，以免模态层遮挡运行页面。

设置中的“工作区布局 → 经典布局”恢复原层级/属性、视口下方资源区和原有资源 Tab。销毁工作区也会恢复原 DOM 归属；重复销毁安全。使用公开的 HaiYue UI split 属性和浏览器 dialog，不访问组件私有实现或另一个仓库的源码。

布局偏好保存在设备级 `haiyue.ai-studio.workspace.v1`，仅含模式、Tab、分类和高级面板 Tab，不含项目内容。经典比例继续使用原 `haiyue.ai-studio.split.v2.*`；新布局独立使用 `haiyue.ai-studio.split.intent.v1.*`，首次读取可沿用原比例。损坏、未知版本、超长或不可访问的本地存储都回退默认布局。

窄于 1000 像素时工作区与视口/Agent 纵向排列，面板内部滚动。Tab 支持方向键、Home、End、ARIA 关联和焦点状态；高级抽屉使用原生模态焦点约束、Escape 和焦点恢复。新增控件提供中文和英文。

## 验证与后续接入

[布局测试](../../apps/ai-studio/test/layout/workspace-electron.test.mjs) 在隔离的真实 Electron 窗口加载产品 HTML/CSS 和公共 shell 导出，验证布局、冻结合同、键盘、偏好、窄屏与回滚。[产品 smoke](../../apps/ai-studio/test/electron-smoke.test.mjs) 验证真实 Scene、脚本、History 和 WebGPU Play。运行 `npm run m14:workspace:check` 可构建并复验；`npm run check` 包含该组测试。

G05 应从项目编排服务注入绑定、manifest 和已校验定位回调；G06 注入真实资源目录与受控操作；G07 扩展高级编辑内容。不得根据本次 shell 验证宣称这些后续流程已完成。独立验收记录见 [m14-workspace-acceptance.md](./m14-workspace-acceptance.md)。
