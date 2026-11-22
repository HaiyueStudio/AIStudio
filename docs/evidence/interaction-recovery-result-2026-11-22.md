# 交互测试与证据恢复验证

日期：2026-11-22

默认探索、显式正式回归及提升、基于目标命中证据的追加更正、任务范围内的证据读取，以及有界失败恢复已实现。旧版正式回归保持有效，更正保留原轨迹、原断言、失败结论、原因及关联工件。原桌球工程没有被本次工具写入，也未以新 Backend 回合重跑完整桌球对局。

定向检查 140 项通过。工具路径覆盖误点台呢、正确命中母球、追加更正、停止后读取观测与验收通过；真实 Operation Log 关闭重开后仍保留更正关系。负向检查覆盖真实 handler 失败、断言减弱、过期/异属证据、不同初始条件和取消。截图读取提供原图引用与元数据，不把二进制当文本或宣称完成视觉判定。

能力检查 20 组、424 项通过。输入绑定：`sha256:b96f7c8d252f5ca67c7f1d117cb499d10fac3d21391d969518cc8b7c09611a3b`。

完整仓库检查已执行；集成部分 94 个文件、566 项，565 项通过、1 项失败：

- apps/ai-studio/test/m14-integration/product-electron.test.mjs：Existing frozen CPU identity gate: expected i7-7700 / 8 logical CPUs, actual i7-14700KF / 28; gate unchanged（原始日志：.cache/zhuoqiu/integration-output/collected-22.tap）

生成证据扫描：通过，694 个文件、406,295,437 字节。原始输出归档于 .cache/zhuoqiu/integration-output，完整日志为 .cache/zhuoqiu/check.log。测试输出目录恢复原 Git 基线，不推进里程碑。具体数值及适用范围见同名 JSON；设计约定见 ADR 0007。
