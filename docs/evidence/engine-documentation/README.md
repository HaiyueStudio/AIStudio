# 本地引擎文档验证

本次实现把已安装引擎的公开声明、经过审核的 Engine 指南、Studio 实际脚本契约与组件/工具注册表构建为本地版本绑定文档。约 1.15 万条记录包含别名、成员和指南，不能理解为同等数量的独立 API。`corpus.json` 保存产物摘要、来源绑定、各入口数量及检索/读取样本。

## 验证

- `TMPDIR=/private/tmp npm --ignore-scripts run m14:capability:capture`：最终源码的正式能力捕获，131 项通过。依赖已完整构建，`--ignore-scripts` 避免重复 prebuild；捕获器仍执行应用构建和所有注册测试。来源绑定见 `capability-verification.json`。
- 最终分阶段检查：检索评估 59、行为 33、工作区 5、工具 117、逻辑 23 项通过。各套件有重叠，不能简单相加。命令、退出状态及原始日志见 `check-phases.json` 和同名日志。
- 集成测试运行全部 51 个文件：245 项通过、2 项失败。拓扑图悬浮框关闭断言失败，单独重跑仍可复现；另一项是本机 Mac 与冻结 Windows 硬件基线不匹配。未放宽这两个断言，也未声称总检查全绿。
- Engine `npm run docs:check`：文档链接检查及导出器测试通过。`api:check` 检测到既有公开 API 基线差异，原始输出见 `upstream-api-baseline.log`；本任务没有修改 Engine API 源码或更新冻结基线。
- 新增文档回归覆盖中文/英文/精确符号查询、Studio/native 隔离、完整分页、预算、版本与游标失效、私有成员排除、工具执行/日志 artifact、真实 Studio 编译和自身旋转执行。应用测试验证打包资源与运行时声明一致。所有原生文档示例并未逐一运行。

## 检索评估的解释

`retrieval-ab.json` 使用最终工具选择代码与真实文档加载器，对七类固定查询比较全量工具 schema 和按需选择。期望工具命中和 Recall@8 均为 1；schema 字节减少约 65.1%，输入 token 估算减少约 57.9%。这里的 token 仅按 schema 与自动检索片段字节数 / 4 估计，未计入完整对话或显式 `engine.docs.read` 返回值；这也不是实时模型生成游戏的成功率。没有消耗远端模型调用，也没有修改用户游戏。

`regression.log`、`focused.log` 是开发中间的定向检查记录；最终结果以正式能力记录和分阶段日志为准。先前失败记录用于保留 macOS 临时路径符号链接限制和初次工具 census 映射遗漏的修复过程。

应用已构建，本轮未重启正在运行的 AIStudio。
