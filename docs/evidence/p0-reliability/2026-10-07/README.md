# P0 可靠性验证（2026-10-07）

本轮覆盖持久续跑、长会话未决交互恢复、官方工具执行回执与重复执行保护，以及能力证据重采集。未切换生产 Harness/alpha 依赖，未调用付费在线模型，未推进 milestone。

## 历史证据保留

`before/` 中的两份文件与实施前 Git HEAD 字节一致：

| 文件 | SHA-256 |
| --- | --- |
| m14-capability-census.json | 13576bf59d65e24425d27c21c30445ee50be345bc542e12f8ab113fb36a93825 |
| m14-capability-verification.json | ffad3ad8d4a723a7042c296fcee9b95d087ef23eccade5ae88c43a4a6ce92b27 |

旧集成测试生成目录另备份于 `/private/tmp/aistudio-p0-integration-before-20261007`，不将旧报告冒充本轮结果。

## 验证范围

- Session resolution 与 continuation artifact 引用同条落盘；决定落盘后入队前中断、运行中排队回答、领取后中断、显式取消和重复提交。
- 领取后中断不自动重放；用户从现有恢复入口接续后关闭旧 continuation，保留原回答，下一次启动不再次覆盖任务状态。
- 2,100 条投影和 3,100 条无关日志之后，旧未决问题仍可见并可答复；关闭并重新打开日志验证恢复，不依赖当前 Host 的内存队列。
- 原计划、审批、预算继续/停止、历史预算归属及作用域授权保持有效。
- 预览由 Host 从结构化结果按原字段路径脱敏后截断，不直接保存 provider 渲染文本；覆盖普通密码和自定义敏感字段。
- Bridge 的前置拒绝、后置失败、超大返回；Host 的非 JSON/超量输出、执行后取消、未知执行结果及回执脱敏；重建工具适配器后同一不确定副作用仍拒绝再次派发。
- summary / digest 压缩保留回执、artifact 引用及禁止自动重试的提示；真实 Harness + Host 使用 HTTP fixture 验证端到端交付，不进行付费请求。
- 正常成功后可以再次执行同参数操作，明确未开始的拒绝可重新准备，只读调用保持可重试。已热启动的回执索引按日志序列增量读取后来导入的项目历史，避免漏掉导入记录中的未决副作用。

## 命令与结果

P0 定向集 **86/86 通过**，0 fail / skip / cancel，日志见 [focused-tests.tap](focused-tests.tap)。覆盖 Host、异步恢复、续跑校验、错误投影、官方工具适配、Bridge、共享契约和 Operation Log。

检查点功能分组 **25/25 通过**，日志见 [checkpoint-tests.tap](checkpoint-tests.tap)。首轮 capture 在 G11 的约两秒轮询等待上超时，未覆盖当前正式证据；原始失败见 [capability-first-attempt.log](capability-first-attempt.log)。该测试现订阅 Host 状态通知并使用 10 秒挂起保护，最终任务、验收次数、任务身份和证据断言保持不变；产品性能阈值与设备门槛未修改。

最后增补的导入历史与日志扫描回归 **39/39 通过**（其中包含已有工具回归），见 [receipt-import-tests.tap](receipt-import-tests.tap)。

恢复、预览交接、执行图、指针与工具运行时的后续预检 **163/163 通过**（含真实 Electron 进程），见 [recovery-window-tests.tap](recovery-window-tests.tap)。

第二轮 capture 在完成源码审查时主动终止，以补齐预览字段级脱敏，未写入正式证据；日志见 [capability-second-attempt.log](capability-second-attempt.log)。字段级脱敏后的官方工具、Bridge、契约与真实 Host 回归 **45/45 通过**，见 [receipt-redaction-tests.tap](receipt-redaction-tests.tap)。

第三轮 capture 的前 17 组通过，最后 pointer-gestures 组 96/97 通过，资源导入用例在约 850 秒后触发 command-cancelled，未写入正式证据，见 [capability-third-attempt.log](capability-third-attempt.log)。系统电源日志确认 10:39:05–10:53:19 发生约 854 秒合盖休眠，见 [sleep-interruption.log](sleep-interruption.log)；不改源码和门槛复跑同一用例 **1/1 通过**，见 [asset-rerun.tap](asset-rerun.tap)。随后使用仅作用于命令生命周期的 `caffeinate -i` 重新执行正式 capture，并在成功后自动执行全量 check；它防止空闲睡眠，不保证阻止合盖休眠。

第四轮正式 capture **18 组、345/345 通过**，0 fail / skip / cancel，日志及报告保存在 [capability-before-fixture-fixes.log](capability-before-fixture-fixes.log) 和 [capability-before-fixture-fixes.json](capability-before-fixture-fixes.json)。输入摘要为 `sha256:f027a590bf7a1d66f9d6479fd3e1995d1346624ee1346df762492228946b20d7`，环境为 Node v24.19.0 / darwin / x64。

首轮全量 `npm run check` 通过契约、类型、边界、pins、协议、59 项 quick evaluation、capability check、构建、19 项文档、34 项行为、5 项工作区、218 项工具及 23 项逻辑回归；最终集成清单完整执行 **74 文件、404 通过 / 5 失败**，原始日志见 [check-first-attempt.log](check-first-attempt.log)，清单见 [first-collected-tests.json](first-collected-tests.json)。旧 stale capability 阻塞已越过。失败处理如下：

- G10 旧断言要求每次规划前读取项目，与已有按需读取提示不一致；现在验证缺失/失效时读取及复用已确认上下文两部分。
- G08 夹具仍断言原尺寸截图，而产品既有策略是半尺寸分析图；改为验证 240×160 输出，同时保留 480×320 运行视口、画面内容、状态、授权与清理断言。缩放检查等待实际 viewport 匹配，不再假定两帧完成跨进程缩放；原 25 秒挂起保护保留。
- 计划审批窗口暴露真实布局缺陷：320 像素宽时批准按钮被待确认区裁剪。表单改为两列，完整授权说明跨列显示，压缩摘要与输入框默认占用；不改审批权限和事件。夹具同步验证“正在提交…”状态及重绘后禁止重复提交，并用独立新计划测试修改意见路径。
- 产品大项目性能测试固定要求 Windows 10 / i7-7700 / 8 逻辑核心；当前 darwin / i7-9750H / 12 核不符合。未放宽、跳过或伪造此门槛。

前两项定向回归 **13/13 通过**，见 [fixture-rerun.tap](fixture-rerun.tap)；窄窗口审批流程回归 **1/1 通过**，见 [plan-review-rerun.tap](plan-review-rerun.tap)，截图见 [plan-320x600.png](plan-320x600.png)。

## 最终结果

修复后正式 capture **18 组、345/345 通过**，0 fail / skip / cancel；[完整采集日志](capability-capture.log)。当前正式 census、verification 和最终集成结果共同绑定输入摘要 `sha256:f68ca09ed99072d278923f1e1cd3bcd7901b2c9537d6e254a300e06411541cbd`。

最终 `npm run check` 完整执行到集成阶段，**退出码 1**，不宣称全量验收通过。前置契约、类型、边界、依赖 pins、协议、quick evaluation、capability check、构建、文档、行为、工作区、工具与逻辑门禁全部通过。集成清单完整执行 **74/74 文件，408 通过 / 1 失败，0 跳过 / 取消**；[完整检查日志](check.log)、[集成清单与计数](integration/collected-tests.json)。各组和定向回归存在重叠，不将计数相加当作独立覆盖量。

唯一失败为 `m14-integration/product-electron.test.mjs` 的固定设备条件：`product-main.mjs:147` 要求 Windows 10.0.19045 / i7-7700 / 8 逻辑核心，实际为 darwin 25.6.0 / i7-9750H / 12 逻辑核心。编辑与重启阶段已完成，大项目性能采样在机器匹配断言前终止；[失败原始 TAP](integration/collected-20.tap)。需要在指定 Windows 基准机补跑此性能验收，不能据当前环境判定其性能预算通过。

首轮其他四项失败均已在最终集成清单中通过：G10 11/11、预览设备夹具 2/2、窄窗口审批 1/1。最终生成文件扫描通过，扫描 665 文件、0 crash dump；[扫描报告](integration/secret-scan.json)。该扫描包含生成目录中保留的旧文件，不能解读为 665 个新生成用例或真实凭证存储审计。

为保留历史验收且避免大量设备截图覆盖旧记录，原受版本控制的 `test-output/` 恢复到实施前内容；本轮全部 74 份 TAP 与汇总另存于 `integration/`。完整生成目录另有本地归档，位置和范围见 [generated-archive.json](generated-archive.json)。本轮正式能力报告保留新生成版本，历史版本仍在 `before/`。

```sh
TMPDIR=/private/tmp npm run m14:capability:capture
TMPDIR=/private/tmp npm run check
```

当前 `delivery` 回执范围是 provider/bridge 到 Host。更外层 Backend 发送失败仍由现有 `tool.outcome-unknown` 记录处理。未知外部状态需要检查现状后恢复；本轮不宣称对任意外部系统提供 exactly-once。
