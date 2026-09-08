# G07 高级手动编辑叶模块与 G09 交接

本次交付独立高级模块和 AIStudio 适配层。验收证据在 `test-output/checks.json`、`test-output/acceptance.json`，Editor 对应证据在 `Editor/editor-shell/test/advanced-authoring/test-output/checks.json`。共享候选尚未更新，生产应用仍使用 G03 的既有高级入口；本次不认定 product-integrated。

## 实现与边界

- 当前审核候选中，Editor Platform 已提供 Selection、DocumentHost、History、Tasks 和生命周期；Shell 已提供布局、惰性插件加载和历史快捷键；UI 有基础树与输入组件。它们尚未导出完整层级、组件检查器、Gizmo 和运行时检查的可复用组合。原 Scene Editor 的 TransformGizmoController、实体层级和 RuntimeInspectorBridge 依赖私有产品命令或 Engine World，不能直接导入。
- 在 Editor 的独立 `editor-shell/src/advanced-authoring` 叶目录抽取产品中立的受控面板、投影验证、层级分页、字段输入和 Transform 手势。已有公共 SDK 足以表达 Selection/History，故没有再往 editor-platform 放置一份领域模型。面板按需加载，拥有并清理所有监听、临时预览和待处理操作。
- AIStudio 的 `packages/studio-shell/src/panels/advanced` 通过 Pick 复用 GameDocumentV2 的 id/revision/entities/components，并直接使用 ComponentDefinitionV2、ObservationArtifactV2 和 SDK Selection/History 类型，只输出临时展示数据和 typed intents。输入不要求脚本源码、资源路径或完整项目。组件元数据、版本、默认值和字段约束来自注册表；未知组件版本只读。嵌套数组/对象可用 JSON 字段编辑，完整组件值入口支持可选字段。
- 写操作转换为原有 entity.rename、entity.hierarchy、component.add/set/remove、transform.batch；选择走同一个 UnifiedSceneSelectionService；撤销/重做走原 workspace。适配层不调用工具、不批准操作、不创建 History、不直接改 Document。工具策略和完整字段校验仍由原服务负责。
- 意图绑定 documentId、精确 revision 和每次项目打开的 epoch；交给 owner 的 stamp 还含 selectionRevision。Transform 校验选中实体及 before 值。运行时观测按真实 ObservationArtifactV2 的 playId/revision 标记 current/historical，跨项目或打开代次的观测不显示。它不把运行时值写回创作文档。
- 惰性 loader 注入值为 unknown，检查 API 版本、验证器和 mount 方法。只持有生命周期 facade，不复制 Editor 的版本化 presentation interface，也不使用跨仓 src/dist 深导入。真实 Editor 窗口与 AIStudio 真实服务分别验证，再用生成的纯 JSON 投影校验两端的展示契约。

## 验证与限制

```powershell
# AIStudio 先按现有方式完成依赖构建
npm run build -w @haiyue/ai-studio-shell
node apps/ai-studio/test/advanced-editor/verify.mjs
# Editor 中运行其叶目录 verify.mjs，可指定上一步的 studio-view.json
npm run m14:capability:capture
npm run check
```

AIStudio 测试使用真实 ProjectWorkspace、注册表、工具审批、OperationLog 和统一 Selection/History，覆盖组件增删改、名称/层级/Transform、撤销重做、非法字段、缺少审批、取消、精确版本、项目重开、加载失败及迟到回调。运行时数据测试通过真实 Observation repository 持久化受控 fixture；它不冒充真实 Play 进程或 Backend 在线验收。

Editor 用实际 Electron 43.2.0 窗口验证原生拖拽、键盘、组件表单、1000 实体分页、字段分页、只读运行时、375px 窄窗口、Accessibility 树、反复卸载及预览回调故障。数学检查覆盖父级旋转/缩放、本地与世界方向、吸附、中心旋转、单个 History 事务。世界旋转遇到不可表示的非均匀父缩放会明确拒绝；缩放为本地坐标。AIStudio 现有选择服务目前只开放单选，所以适配层明确关闭多选，公共 Editor 模块仍支持受控多选。

源码、测试、本文与输入包版本参与摘要，生成的 test-output 按现有 census 规则排除。Editor 源码单独绑定，不能用 AIStudio 的旧候选摘要代替它。当前 installed candidates、tarball SHA256、lock integrity 和 exports 从 `config/upstream/editor-candidates.json`、实际 tarball、安装目录和 lockfile 逐一核对并写入 checks.json；其中 Shell 0.1.0 的已审候选 SHA256 为 `7fb97069d33a7181986af4735dd58857ddae7a324dc583f82eea44faf66d296e`，仍不含新的高级导出。

## G09 串行集成清单

1. 审核并正式导出 Editor 的 `./advanced-authoring`、声明与 CSS；将 CSS 纳入打包产物。更新候选版本/来源 revision/tarball 摘要、AIStudio candidate pins、依赖与 lockfile，并验证打包后导出和独立消费。当前叶 index 不能当作已存在的公共出口。
2. 给 studio-shell 适配层增加正式内部 export，装入既有根 scope；使用真实公共 Editor subpath 注入 load，保持动态加载边界。不要复制测试里的协议 double、跨仓源码路径或临时浏览器入口。把两仓叶测试接入共享 check；目前顶层通配符不会自动运行子目录测试。
3. 既有项目 owner 提供已校验且脱敏的 GameDocument、注册表、SDK Selection/History、打开 epoch 与观测来源。IPC 输入仍为 unknown 并经过既有边界验证；不把完整 GameDocument 的脚本源码或文件路径广播给面板。投影函数仅取实体、组件和展示所需运行时字段。
4. dispatch 在 prepare、等待审批后、commit 前复核 stamp 与 AbortSignal，沿用当前统一工作流，不自动审批；Undo/Redo 也要在现有串行 owner 内检查项目身份与精确 revision。组件/脚本定位复用 G05/G03 已有来源入口，脚本编辑与首次执行授权仍留在原流程。
5. viewport owner 提供当前相机下以 CSS 像素计的世界轴投影、敏感度与枢轴位置，局部轴由公共模块计算；视口/相机/选择变化时更新。临时 preview 只覆盖显示，null 恢复权威快照；不得以 preview 写 Document 或反馈成新权威 revision。focus-selection 走原 framing 操作，运行时刷新走原 play.inspect 与真实观测存储。
6. 项目关闭/切换先取消并卸载旧面板，再为新 epoch 挂载；关闭高级面板也释放监听与预览。将 G03 高级入口接到新模块，保留现有脚本入口、统一选择与历史，合并局部样式并完成产品文案本地化。
7. 在实际安装候选后的主窗口完成手工精调、两个 Backend、七类游戏和六层组合验收后才标记 product-integrated。G07 独立验收不改变 M12 G12 blocked、M13 G11 active，也不自动启动 G08/G09。
