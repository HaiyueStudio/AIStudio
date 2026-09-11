# 圆角立方体与知识检索修复（2026-09-11）

## 原因与修复

本机生成记录显示：原始魔方请求为 175 UTF-8 字节，明确要求圆角；实际 27 个 cubie
使用 `kind: cube`。已批准方案 1767 字节与第一轮修复指令 1662 字节组合为 3431 字节，
整段作为检索 query 传入 2048 字节上限接口，导致 `knowledge.query-invalid`。

- 接入当前已安装 Engine 的公开 `experimental.createRoundedBox3D`，新增 `rounded-box`。
- 单个/批量创建、IPC、组件配置、资源模板、编辑和 Play 共享类型与参数。
- 参数范围：本地单位 `radius` 0–0.5，默认 0.075；`segments` 整数 1–16，默认 4。
- 工具中文发现和本地知识指南说明真实圆角、坐标空间、默认值和已有方块转换方法。
- 检索对超长文本生成 UTF-8 安全首尾摘要，保留完整脱敏模型任务文本及原有权限过滤。
- 未修改用户当前魔方工程，未重启正在运行的 AIStudio，也未升级 Engine 依赖。

[使用说明](../../architecture/rounded-box-authoring.md)

## 专项覆盖

- 工具发现、单个/批量创建、无效参数拒绝、已有 cube 转换、Undo/Redo、保存重开。
- 手工 Scene 创建与 Agent 创建共用组件校验；非法参数不得提交。
- 编辑与 Play 几何具有相同顶点/法线、本地边界；正半径确实移除尖角并生成平滑法线，
  零半径恢复普通立方体。
- IPC 参数验证与转发，资源模板共 8 类几何，本地知识可检索圆角指导。
- 检索覆盖 2048/2049 字节边界、长中文和 emoji、审批方案加修复续执行、空白文本；
  完整任务保留，私有知识不泄漏，底层直接检索仍严格拒绝超限查询。

## 测试环境

macOS 临时工程使用 `TMPDIR=/private/tmp`，避免默认 `/var` 符号链接被项目历史边界拒绝。
Electron 窗口测试需要 macOS 窗口服务访问权限；受限运行环境会在 `_RegisterApplication`
启动阶段 SIGABRT。允许窗口服务后，相同测试通过。没有降低应用 Electron 安全配置或
项目历史路径校验。

已运行完整 workspace 依赖构建；随后使用 `npm --ignore-scripts run ...` 跳过重复的
prebuild/pretypecheck 钩子，能力捕获及 `check` 中的显式构建和检查步骤仍执行。

## 已完成的能力核验

当前源码、组件注册表、工具 schema 与候选包绑定核验通过：12 组共 123 项，0 失败、
0 跳过。完整记录见 [capability-capture.log](capability-capture.log)。
专项记录： [regressions.log](regressions.log)、[retrieval.tap](retrieval.tap)、
[knowledge-loader.tap](knowledge-loader.tap)、[geometry-ipc.log](geometry-ipc.log)、
[electron-window.log](electron-window.log)。

## 最终仓库检查与复验

`check` 的契约、类型、边界、候选包、59 项评估、33 项行为、5 项工作区、108 项工具、
23 项逻辑检查通过。最终集成完整执行 48 个文件：223 通过，4 失败，0 跳过/取消。
见 [repository-check.log](repository-check.log) 和 [integration-results.json](integration-results.json)。

同一源码串行复验失败窗口，两个执行图和通知设置窗口均通过；产品 author / restart 阶段
也通过。唯一仍失败的是 large 阶段的固定测试机断言：要求 Windows 10 / i7-7700 / 8 逻辑
CPU，本机为 macOS 25.6.0 / i7-9750H / 12 逻辑 CPU，未执行该阶段的后续性能验收。
因此不能声称整个 `check` 全绿，也未修改测试机要求。见 [window-retry.tap](window-retry.tap)。

最终源码绑定复核通过，生成测试输出已恢复为本任务开始前的内容；本轮结果单独保存在本目录。
已构建的修复需重新启动 AIStudio 后加载。现有普通方块不会自动改变；可通过几何组件
将 kind 改为 rounded-box，再按需要设置 radius / segments。当前用户工程未被改写。
