# G06 资源目录独立验收与 G09 接线交接

本目录交付 `g06-resource-catalog-intent-workflows` 的资源服务、面板、typed intents 与独立验证。
当前结果及输入摘要见 [checks.json](./test-output/checks.json)，组合检查状态见 [acceptance.json](./test-output/acceptance.json)。
验收状态由 milestone.json 的 G06 completion 认定；此处的独立窗口不代表生产应用已集成。

## 已实现的边界

- `packages/editor-plugins/src/assets/resources`：组合原有 ControlledAssetCatalog、GameDocument、ComponentRegistry 与 asset.dependencies，只生成只读目录。资产不重发 ID；模板默认值与版本来自实际注册表；实例绑定项目、实体、组件及当前修订。
- 使用位置逐条核对原组件与 JSON Pointer；查询失败、截断、脚本动态使用和额外项目配置保持 unknown。未知使用不会进入“已确认未使用”筛选。场景实例不适用资产清理。
- 灯光模板、灯光实例、环境纹理和不可用预设同属 Lighting，但操作按 kind 分派。注册模板复用 entity.create、material.set 或 component.configure；文件导入/分配复用 asset.import/assign；不增加工具注册表、History、Document writer 或根生命周期。
- 检查文件复用受控读取与原有格式/许可/解码预算，核对字节摘要；缺失、替换和目录逃逸失败可见。刷新可以重新核验。项目复制保留资源身份，同时清除旧存储位置的健康缓存并拒绝晚到读取。
- 未提供通用配置预设的持久化模型，因此 preset 只显示不可用说明，不生成持久化配置或应用操作。原有 prefab 工作流仍归原服务。字体、Spine、tilemap 不因分类而获准导入。
- `packages/studio-shell/src/panels/resources`：只显示有界读模型并发出意图；支持搜索、分类/种类/状态/未使用筛选、分页、详情、许可与来源、使用位置、目标实体与适用操作、错误、取消、键盘与窄窗口。没有文件访问、工具调用或审批策略。

## 验证方式

先按仓库现有方式构建依赖与应用，再直接运行：

```powershell
npm run build -w @haiyue/ai-studio
node apps/ai-studio/test/resources/verify.mjs
npm run check
```

verify.mjs 执行叶目录服务/呈现测试、既有资产回归、独立真实 Electron 资源窗口以及既有生产预览资产生命周期回归，输出 TAP、摘要和窗口证据。窗口采用 sandbox、contextIsolation、最小测试 IPC，实际消费服务、工具、审批与 History；主窗口不装配此模块。

覆盖四类合法引用与允许操作、错 kind/未知版本/旧修订/混用拒绝、真实默认值提交、审批拒绝、撤销/重做、项目重开/复制、路径 containment、格式/源大小/decode budget、重复摘要、缺失依赖、未知使用、取消/迟到/释放。UI 使用实际 Document 的 0/1/100/1000 实体与 200 脚本，核对分页、长名称文本转义、导入失败、缺失资源、原生键盘、375px 布局及 Chromium Accessibility 树。Accessibility 树检查不冒充人工屏幕阅读器试听。

`test-output` 按已有 census 规则排除出输入摘要；测试及本文本身仍参与源码绑定。刷新现有 generated census/verification 后，必须确认 checks.json、当前 census 与 acceptance.json 的 inputDigest 一致。

## G09 必须完成的接线

1. **共享导出与构建**：为 editor-plugins 的资源叶模块、studio-shell 的资源叶模块与 resources.css 增加正式内部 workspace exports/build 入口；当前仅叶 index，未改共享 index、package.json、锁文件或候选包。运行时不能照搬测试中的内部 dist 路径导入。
2. **项目生命周期**：在既有根 scope 中拥有 ProjectResourceCatalog，注入既有 workspace、G05 权威来源回调与 G02 的 createBehaviorSourceBinding、parseBehaviorContract。切换/关闭项目先 cancel/dispose；不把它放进第二个全局资源池。viewToken 是与项目打开代次绑定的临时令牌，不能只用 revision 或可复制项目的 digest 代替代次。
3. **唯一工作流**：dependencies 注入真实 asset.dependencies 的 value；request 注入既有工具/审批流程，并在 prepare、等待审批后、execute 前重新检查项目打开代次、documentId 与 exact revision，传递 AbortSignal。低风险与高风险操作分别遵守原有策略；服务与面板不自动批准。工具失败使用固定脱敏诊断。
4. **读取与 IPC**：主进程持有 ResourceCatalogBinding 和当前 query；只向 renderer 发送已验证、脱敏且限额的 ResourcePanelData。ResourceCatalogEntryV1 与 EditorLocationV1 继续用 G02 验证。实例配置按需序列化、文件 metadata 只含受控相对路径/许可/预算，不传绝对项目根、脚本文本或文件字节。拒绝未知版本、额外字段和旧 viewToken；不能把本目录的测试 IPC 当作生产协议。
5. **面板动作**：query/refresh/cancel 调用服务；action 映射 execute；locate-use 映射 locateUsage。统一位置校验后，脚本入口走现有源码定位，组件/实体入口走原有高级编辑器或 G07 公共 seam，实例修改仍用原有受控编辑流程。select-target 使用既有场景选择，不重建层级树。
6. **导入**：import 意图只有已准入 kind；由现有受控导入表单收集项目相对路径、格式、许可、来源和预算，再调用 importAsset。实际文件选择/审批归原流程。controller.mjs 的固定失败文件只是测试输入，禁止用于产品。
7. **状态与测试入口**：把 resources 目录测试接入正式 check；新增模块测试不被当前只匹配顶层文件的脚本自动包含。完成候选/应用装配与真实主窗口、两种 Backend、七类游戏及六层组合验证后，才能认定 product-integrated。G06 独立通过不解除 M12/M13 或其他 Goal 的门禁。

没有修改 G07、高级编辑公共 seam、共享 shell 入口、应用 renderer 或全局样式。G09 仍拥有最终集成与正式能力准入。
