# M14 G01 独立验收记录

日期：2026-09-06。结论：G01 complete，仅接受能力 census、合同及首版范围/验证计划，不构成 M14 产品验收。

用户明确授权“允许 G01 提前实施并独立验收”。M13 G11 保留 active，M12 G12 保留 blocked；G03 及后续 Goal 未启动，继续受原里程碑前置门禁约束。

## 验收绑定

- 当前工作区输入：`sha256:eb59ae46c5c0b873263613d238ff971de0a563d0fcb67dea9f835b805fb83839`。
- 环境：Windows x64，Node v24.19.0；当前工作区包含前序尚未提交的修复，不标注为已发布版本。
- [机器矩阵](../../config/contracts/m14-capability-census.json) 记录 35 个既有能力 ID、44 个组件、47 个业务工具，以及 8 个安装包的 87 个 export 入口和发行内容绑定。调用传输入口单列。
- [结构化检查记录](../../config/contracts/m14-capability-verification.json) 保存构建/检查入口、开始时间、时长、通过/失败/跳过数量和输出摘要。这里的输入摘要作为本日审计记录保留；后续 current 产物更新不能改写本日结论的绑定。

## 已执行验证

| 验证 | 结果 |
| --- | --- |
| 当前 workspace 构建与 9 组定向测试 | 78 项通过，0 失败、跳过、取消 |
| CapabilitySurfaceRecordV1 合同 | valid、invalid、unknown-version、secret-bearing fixtures 通过；缺层/空证据/未知 capability/历史冒充当前被拒绝 |
| 能力准入与范围检查 | local-check 不能升级 adapter/product；G06 超额、新领域、无既有 adapter、缺预算和假纯声明式覆盖被拒绝 |
| 包/lockfile/candidate/registry 交叉验证 | 实际公共 exports 与源码核对通过；内容绑定包含内部转导出文件；输入变化后旧报告被拒绝 |
| AIStudio `npm run check` | 全部通过，含 contracts、类型、边界、上游锁定、候选包、协议检查、58 项既有 quick checks 和新增 census gate |
| Editor candidate checker（显式传入 M03 milestone） | M03 complete，4 个 Editor 候选的公共导出、版本和 lock integrity 通过 |
| milestones `npm run check` 与文档/状态审计 | 通过；9 Goal DAG 无环，引用可解析，G01 例外及前置/后续状态一致 |
| 两仓 `git diff --check` | 通过 |

## 验收边界与交接

六层记录已冻结，生成器只消费原有注册表，不形成第二个运行时注册表。所有 stage 保留 implementation-present；当前本地回归单独记录，未伪造 adapter-ready/product-integrated。

[首版范围](../../config/contracts/m14-capability-first-release.json) 冻结 G06 零项新增阻断项及最多两项上限，三类来源 corpus 和数值预算已交接。现有 g08-declarative-play 窗口用例为混合来源；纯声明式无脚本的窗口验证、行为结构/解释/轨迹和设备绑定断言由 G04/G09 完成。行为/资源合同仍归 G03，正式适配与产品验收仍归 G06/G09。

本次没有运行真实 Backend 七类游戏正式验收，也没有改变 M12/M13 的历史基线或发布状态。详细证据语义与复现入口见 [能力面说明](./m14-capability-surface.md)。

## 编号说明（2026-09-07）

以上保留 2026-09-06 验收时的编号与输入摘要。旧 G03/G04/G06/G08 现分别为 G02/G05/G08/G07，完整 [编号对照](../../../milestones/milestones/m14-ai-native-intent-graph-editor/goal-renumbering-2026-09-07.json) 用于解释历史引用。当前机器矩阵与检查记录会按新编号重新采集；本日历史结论不随重新采集而改写。
