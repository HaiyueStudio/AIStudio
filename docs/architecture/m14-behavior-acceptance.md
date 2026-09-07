# M14 G02 独立验收记录

日期：2026-09-07。验收范围为多来源行为、结构/解释/轨迹、四类资源身份及基础只读服务。用户按新编号显式启动 G02；本次不改变 M13 G11 active、M12 G12 blocked 或其余 Goal 的启动门禁。

当前工作区输入绑定：`sha256:c9289545a597b110abdf3ed87e263e86abf3de1f9f0d410bb8023a2934ddcd3b`。该值来自重新构建后生成的 [当前能力检查记录](../../config/contracts/m14-capability-verification.json)，覆盖代码、配置、测试、依赖和安装包输入。G01 的历史验收摘要未重写。

## 逐项验证

| G02 要求 | 实现和验证证据 |
| --- | --- |
| 六个共享 envelope、schema、fixtures、唯一 owner | [m14.ts](../../packages/studio-contracts/src/m14.ts)、[合同索引](../../config/contracts/m14-contract-index.json)；额外输入合同复用 GameDocumentV2/ComponentDefinitionV2；所有 schema ID/路径一致，六个名称只在 studio-contracts 定义 |
| 纯脚本、无脚本规则/计时器、物理/动画、混合来源 | [四来源固定 corpus](../../config/contracts/fixtures/m14-behavior-inputs.json) 和 [公共消费者测试](../../apps/ai-studio/test/m14-behavior-contract.test.mjs)；实际 DeclarativePlayRuntime 在计时边界的 score 结果独立核对提取关系 |
| 串行、条件、循环、Promise 聚合、await、输入、碰撞、动态调用、异常和取消 | [分析测试](../../packages/script-preview/test/behavior-analysis.test.mjs)、[轨迹测试](../../packages/script-preview/test/behavior-resources-trace.test.mjs)；覆盖名称遮蔽、finally 返回不穿透、指针/自定义回调、跨实体 action 目标；adapter 内部和碰撞是否发生明确 unknown |
| 完整输入/分析器/config 的确定性与失效 | 同一输入及集合重排得到相同 manifest；组件值/启用、依赖、registry、adapter 版本/摘要、项目身份变化失效；config 和 analyzerVersion 进入结构摘要；保存时间不进入结构 |
| 解释和运行路径不污染结构 | en/zh-CN 得到不同 explanation digest、相同 manifestDigest；跨 Play/generation、修改运行事件不修改 manifest；解释只描述来源与结构，运行事实只从观察关联获得 |
| 源码映射、字段定位及过期保护 | 原始 UTF-16/CRLF/Unicode 范围核对；组件 JSON Pointer 定位；伪造范围/字段、修改脚本和复制项目后旧位置只显示 historical；query/locate/explain 要求精确绑定 |
| 大 AST、投影截断和 worker 取消 | AST/node/edge 预算测试、trace 10000 行及 4 MiB 两种截断测试；abort、请求替换、invalidate、重复 dispose 均使用真实 worker，迟到结果不能发布 |
| 资源四类身份、混用拒绝、未知依赖、不适用 unused | [资源 fixtures](../../config/contracts/fixtures/m14-resource-contract-cases.json) 和资源测试；沿用实际 ControlledAssetCatalog 的 id/digest、许可和预算校验；未接入持久化/创建流程的 preset/template 不伪装为可用项目记录 |
| 每个 envelope 的未知版本和敏感数据拒绝 | [行为 fixtures](../../config/contracts/fixtures/m14-behavior-contract-cases.json)、[位置 fixtures](../../config/contracts/fixtures/m14-editor-location-contract-cases.json) 与资源 fixtures 同时运行 schema/runtime 校验；额外拒绝 OAuth token、凭据路径、getter、live object，截断尾部也校验 |
| G03/G04 独立消费，无第二写入链路 | 公共包导入的 TypeScript 消费者将 BehaviorReadService 赋给 BehaviorReadPort；头部编排包只依赖合同；分析前后输入序列化不变，不执行 Document.apply 或 History；module boundary gate 通过 |

## 已运行检查

- `npm run contracts:check`：53 schemas、8 fixture 文件，53 valid / 82 invalid 全部符合预期；包含既有合同。
- `npm run m14:behavior:test`：24 项通过，0 失败/跳过/取消，随后在仓库总检查中再次通过。
- 原有 `script-preview.test.mjs`：6 项通过，覆盖授权、History、隔离 Play 和生命周期回收。
- `npm run m14:capability:capture`：重新构建全部应用依赖与 renderer，9 组既有能力检查共 78 项通过；35 capabilities / 44 components / 47 tools，未升级为 product-integrated。
- AIStudio `npm run check`：合同、类型、模块边界、上游与候选包、协议、既有 quick gate、current census、新增读模型消费者与测试全部通过。
- milestones `npm run check`：仓库版本策略通过；另核对 9 个 Goal、14 条拓扑依赖，M12/M13 前置和未启动 Goal 状态保持。

## 交接

接口、摘要规则、预算和使用示例见 [读模型说明](./m14-behavior-contracts.md)。私有合同已冻结；G03/G04 可消费分析、query、locate 和解释端口。G05 负责模型解释协调、真实 Play 采集/归档和逻辑视图接线，G06 负责资源创建/持久化工作流。G02 不认定这些后续产品流程已完成，也不以一次运行路径替代全部静态结构。
