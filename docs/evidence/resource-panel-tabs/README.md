# 资源面板分类标签

参考 `Editor/editor/index.html` 的资源分类布局，通过 AIStudio 已安装的
`@haiyue/ui/tabs` 公共组件实现，不引入 Editor 私有源码依赖。

- 默认显示几何体，五个主要标签按几何体、纹理、材质、脚本、模型排列。
- 分类在目录查询阶段过滤，保留分页预算；切换标签回到第一页、清除旧选择和种类/状态/未使用筛选，保留搜索文本。
- 纹理、模型标签提供对应导入按钮。更多筛选默认折叠，仍可查询灯光、音频、动画等现有分类；这些分类在使用时显示临时标签。
- 列表改为紧凑卡片，选中后显示详情。保留四类资源身份、来源、合法操作与使用位置，不改变目录、审批或 History 规则。
- 应用首次查询和项目切换使用与面板相同的默认几何体查询。
- `HYTabs` 在极窄容器内滚动标签栏，标签不缩窄、不换行，内容区保持原宽度。AIStudio 通过
  `haiyue-ui-0.1.3-scrollable-tabs.tgz` 接入：原候选的 51 个文件中仅 `dist/tabs.js` 的 CSS 改变，
  声明、事件和键盘/ARIA 行为不变。源码补丁、基线包和运行时文件摘要由能力包校验验证。

## 验证

`node --test apps/ai-studio/test/resources/panel-electron.test.mjs` 通过。
测试使用真实资源目录、工具及 History，覆盖五个标签、原生方向键切换、分类查询、导入类型、筛选重置、分页、来源定位、文件校验、导入失败、项目重开、晚到结果和重复释放。
0/1/100/1000 实体与 200 脚本的有界显示及 375px 窄面板验证通过。
补充的 206px 验证通过：标签单行、仅标签栏横向滚动、原生 End 键切换并将模型标签滚入视区。
UI 仓库 typecheck、23 项测试和 build 通过。
测试宿主的样式 CSP 与生产窗口保持一致，允许现有 UI 组件的 Shadow DOM 样式。

资源模型回归通过，应用构建通过。
最终当前源码能力捕获 **123 项通过，12 个套件均通过**；生成记录由官方捕获命令刷新，未推进 milestone 状态。
新增一个资源 Tab 组件后，启动冒烟测试的精确组件数量由 4 同步为 5。
`logic-product-electron.test.mjs` 的真实产品启动、重载、Play、来源定位与历史读取复验通过。

所有工作区已先通过默认构建流程完整重建。最终能力捕获及总检查使用
`npm --ignore-scripts run m14:capability:capture` 和 `npm --ignore-scripts run check`，
复用已构建的依赖，避免重复执行 prebuild/pretypecheck 钩子；显式 build、typecheck、边界检查和测试子命令仍全部执行。

- [窄面板截图](resource-tabs-narrow.png)
- [206px 极窄面板截图](resource-tabs-206.png)
- [宽面板截图](resource-tabs-desktop.png)
- [窗口回归日志](resource-window.log)
- [资源操作验证](verification.json)
- [UI 候选包文件差异](ui-candidate-diff.json)
- [生产窗口窄侧栏](production-resources-narrow.png)
- [生产创建与导入流程](production-author.json)
- [生产项目重开流程](production-restart.json)

## 最终总检查

类型、边界、候选包、能力一致性检查通过；行为 33 项、工作区 5 项、工具 107 项、逻辑 23 项均通过。
最终集成集合 **46/46 文件执行，219 项通过、1 项失败，无跳过或取消**，输入摘要在执行期间保持一致。
失败来自大规模产品测试的固定机器断言：要求 Windows / i7-7700 / 8 核，实际是 macOS / i7-9750H / 12 核。
同一产品测试在此之前的 author 与 restart 阶段通过，包含资源分类、创建、导入、Gizmo History、项目重开与无障碍检查。
未放宽硬件或性能断言，因此不将全量检查标记为绿色。

- [完整总检查日志](repository-check.log)
- [集成逐项结果](integration-results.json)
- [固定硬件断言失败](fixed-host-failure.tap)

已保存本次相关证据，并将 111 个生成文件恢复到执行前的暂存版本，未修改用户的暂存区。
清理后能力一致性检查与源码 diff 检查通过。当前用户窗口未重启，未修改用户项目；新版已构建，供下次启动加载。
