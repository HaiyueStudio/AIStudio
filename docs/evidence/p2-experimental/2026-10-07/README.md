# P2 实验能力与 alpha 验证

本轮只完成下列已验证的适配基础。**官方 Team 原生执行与 Stagehand 原生推理尚未接入，不能将 P2 整体标记完成。**

## 实现

- Team 检查入口从 Studio 已批准计划读取同一组 step/task、状态、依赖和写入范围；返回值不引用可变计划对象。原生 Team 准入状态与现有 W7 候选并行资格分开。
- 额外推理复用父任务的 UsageLedger / PricingEngine / BudgetController，支持 input/output/cost 预留、精确归属绑定和最终结算；绑定后拒绝变更计费路由。缺用量、未知价格、仍在运行或已取消但费用未确认的请求不能释放预留。总量保持 unknown/null，费用不标成最终值。
- 设置页展示未开放能力的原因；Stagehand 部署配置或未准入浏览器 backend 明确拒绝，不会悄悄换用 Playwright。
- alpha runner 使用隔离源码快照，从零编译完整应用，检查各 workspace 类型并执行 bridge、恢复与进程测试；保留源码、候选 lock、逐阶段日志摘要和生产依赖文件不变证明。生产仍为 rc.2。

## 已完成验证

- 生产完整应用构建通过（`build.log`）。
- 聚焦回归 33/33 通过（`focused.log`）；追加计费路由不可变保护后，计费 15/15 通过（`accounting-final.log`）。
- 真实 Electron 设置页测试 1/1 通过（`settings-electron.log`）。
- 包边界检查通过（`boundaries.log`）。

- 全新隔离 alpha 全部阶段通过（`alpha/report.json`）：完整应用构建、所有 workspace 源码类型检查、bridge 60/60、恢复 4/4、真实进程矩阵 8/8；零跳过和取消，生产依赖文件摘要不变。源码快照摘要与候选 lock 摘要均在报告中。候选配置只引用此报告，不再重复保存易过期的通过标志。
- 另行逐文件比较 276 个应用/包源码，隔离 alpha 实测源码与最终生产源码完全相同，各阶段日志摘要校验通过（`alpha-source-comparison.json`）。
- 修正 runner 时的失败记录保存在 `alpha-initial/`、`alpha-docs-retry/` 和 `alpha-process-initial/`。前两次缺少隔离构建资源；后一次 Electron Framework 相对链接被复制为绝对链接导致 ICU 资源缺失，同时 DevTools 一次调用失败。保留相对链接后单独复测 3/3，通过全新完整运行最终收口 72/72。

- 生产能力证据重新采集：18 组，345/345 通过；绑定 `sha256:38967d82424282feb3ccc3e2001025680650ae9227fc67c01a9f23ff5e950b21`（`capability-verification.json`）。

首次完整检查将证据目录中的上游 `.d.ts` 声明当作项目源码，触发 bridge 导入边界（`check-boundary-initial.log`）。这些快照已改为 `.txt`、内容摘要未变，原边界规则保留并复测通过（`boundaries-final.log`）。完整仓库门禁重跑完成：前置检查、59 项 quick、345 项能力、19 项文档、34 项行为、5 项工作区、218 项工具、23 项逻辑均通过；集成完整执行 74/74 文件，408 通过、1 失败、零跳过。唯一失败为指定 Windows 10/i7-7700 设备验收在当前 macOS/i7-9750H 上触发机器身份断言（`check.log`、`check-summary.json`）。未修改该断言，`npm run check` 退出 1。测试生成目录归档后已恢复到本轮开始时状态（`generated-archive.json`），保留新能力验证报告。

## 原生接入缺口

1. **Team**：官方 TeamJournal 将任务、成员、消息写入 Lead Session，恢复通过 subagents 服务进行。要实际挂载，仍需完成 Studio durable Session/persistence 与 subagent continuation 的适配，并验证恢复后每次推理经过父任务账本、取消和资格门槛。本轮提供的是 Studio 计划的只读投影，没有安装官方 Team runtime，没有制造第二份任务板。
2. **Stagehand**：固定 rc.2 插件使用 Stagehand 4.1.0，公开模型配置没有请求 token cap，执行返回 MCP 数据，未暴露额外推理的 canonical usage 或费用回调。现有 Host 不能据此保证请求预算，也不能把时间/结果长度折算为 token 账单。因此保留显式未准入状态；新账本结算接口不等于已接通真实 Stagehand 计费。

`upstream-review.json` 保留两份固定 npm 包的 integrity 和声明摘要；旁边保存 MIT LICENSE 与公开声明。只下载到临时目录用于审查，未加入生产依赖闭包。

未调用付费模型、未生成实网 W7 A/B 资格、未在指定 Windows 机器完成验收、未升级生产 alpha、未推进 milestone 状态。

上游参考：[固定 rc.2 Team](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2/packages/experimental/agent-team)、[固定 rc.2 Stagehand](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2/packages/experimental/browser-use-stagehand-native)。具体限制以本目录保留的 npm 公共类型声明为核对依据。
