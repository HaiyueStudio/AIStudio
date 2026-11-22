# 工程加载与历史导入性能

日期：2026-11-22

已增加工程加载遮罩，覆盖打开/新建后的刷新与绘制，并在成功、取消、失败和退出时恢复控件及焦点。后台增加安全的阶段耗时日志，便于区分旧工程释放、文档读取和历史恢复。

桌球只读副本的本机单次对照（同一 journal 哈希）：

| 阶段 | 原实现 | 优化后 |
| --- | ---: | ---: |
| 工程文件读取 | 9.2 ms | 8.2 ms |
| 空编辑器缓存首次历史同步 | 13.04 s | 2.31 s |
| 同一缓存再次同步 | 174.7 ms | 115.2 ms |

首次历史同步耗时减少约 82.3%。主要成本来自逐条刷盘和重复工件复制；日志导入由 4764 次单条追加变为 38 批，工件写入调用从 2971 降为 1440。已有会话内容的离线恢复约 153.4 ms，不包含真实后端连接。样本工程 97,113 字节；这些数字不等于任意工程的整体打开时间，也不是冷磁盘或统计中位数。原桌面工程未被本次工具写入。

59 项定向验证通过，包括真实 Electron 的加载显示、重复操作、取消/失败恢复与销毁保护；还覆盖日志顺序、复制观察者、轮转、脱敏、重开、故障、嵌套工件去重和篡改拒绝。能力检查 21 组、458 项通过。

完整仓库检查的集成部分 96 个文件、573 项，570 项通过、3 项失败。Evidence result-file write failed after behavior assertions; unchanged standalone rerun is recorded separately；日志 .cache/project-loading/integration-output/collected-19.tap。Existing frozen CPU hardware identity gate (i7-7700 / 8 versus i7-14700KF / 28)；日志 .cache/project-loading/integration-output/collected-22.tap。生成证据扫描通过（698 个文件，406,327,533 字节）。原始结果在 .cache/project-loading/integration-output，测试输出目录恢复原 Git 基线。

后续复核保留了原始失败：完整游戏文件不改代码复跑为 6 通过 / 1 失败，原 snake、jigsaw 均通过，但 racing 在最终 JSON 结果写入时出现同样的 Windows UNKNOWN open 错误（gameplay-device.test.mjs:66，行为断言已完成）。再单独复跑 racing 为 1 通过 / 0 失败。原始全量检查仍记为失败，不能以复跑覆盖；固定 CPU 门槛也没有放宽。复核日志分别为 .cache/project-loading/gameplay-recheck.log 和 .cache/project-loading/racing-recheck.log，复核生成文件另存于同名 *-output 目录。

两份基准副本的额外凭据模式扫描均通过，未读取真实凭据库。

输入摘要：`sha256:9a5f26eef968e13933b99f16a8dbaa50610dbbe3091bbc378318d5ee1cf9f07c`。实现约定见 ADR 0008；不推进里程碑。
