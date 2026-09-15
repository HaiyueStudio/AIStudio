# 文档查询与场景编辑并行执行

2026-09-15。本次实现不修改模型提供方，也不启动额外模型。使用现有有界 scheduler/transaction owner，维持审批、版本校验、日志及结果顺序。

- 固定文档/注册表读取与低风险编辑可重叠；scene/assets/runtime 读取仍按屏障或事务完成顺序执行。
- 显式依赖、revision 约束、未知 effect、trusted-code、runtime、approval（包括 entity.create-many）不放开。
- Runtime 固定读取允许同一 Document 内 revision 变化，项目切换继续拒绝。
- Host 等待真正的事务提交而不是只等 prepare 完成；所有后继 stateful calls 等待 transaction tail。flush 时封闭成员，避免迟到的调用加入已提交事务。
- 执行指引让模型一次提交独立低风险 entity.create 和文档查询，依赖 ID/文档结果的步骤等待下一轮。

## 验证

- regression.log：44/44，通过 scheduler、Host、事务、effect lock 和 lifecycle 检查。
- scheduler-final.log：25/25（含后补两条 entity.create-many 审批屏障检查，与上面的 scheduler 用例重叠）。
- runtime-read-revision.log：1/1，真实 workspace/runtime，覆盖四类固定读取、同项目 revision 变化、stateful stale 和项目切换。
- plan-tests.log：23/23，现有计划与模型纠错回归。
- app-build.log：应用构建成功；game-authoring-tools 和 agent-orchestration 也已编译成功。
- root-check.log：总检查未通过。M14 capability census 的 verification input binding 已过期；保留失败证据，未重写验证基准。

测试维护：旧 Host fixture 的 220ms 总墙钟断言包含投影、计费和机器负载，替换为直接验证两个读取同时启动且屏障后工作有序，并保留墙钟诊断。旧 lifecycle fixture 仍预期 task.transition-invalid，但 HEAD 已返回更具体的 task.preview-stop-required；同步测试预期，编辑阻断行为不变。

## 等待时间对照

wait-comparison.json 使用确定的模拟工具等待：两次创建各 90ms、文档查询 240ms。maxConcurrency=1 时约 430ms；maxConcurrency=4 时约 241ms，两个写入仍互斥。这不是模型推理或真实游戏生成的耗时承诺。Host 用例另外通过双向 rendezvous 证明真实事务执行接口和文档执行接口确实重叠，并验证结果按调用顺序交付。

应用尚未重启；未修改用户当前项目。
