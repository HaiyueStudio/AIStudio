# Team 持久化与恢复准入

范围：固定 rc.2 官方 Team 的实验适配层；生产 Team 工具默认关闭，无真实付费调用、无 alpha 升级、无资格或里程碑状态提升。

实现复用 Operation Log/CAS 和父 TaskAccount/UsageLedger；写句柄要求独占 claim，恢复遵循原始 seq 和消息身份。隐藏 reasoning/stream 不保存。官方冷恢复使用 Session Query 精确读取。模型请求边界覆盖直接唤醒 Lead 与恢复队友；未知结果不重发，父账本缺失时暂停。

产品接线尚待真实父任务/批准计划绑定、父账本完整恢复和 Team 专属真实资格。当前实验 transport 的计费由 admission 独占，未来产品组合不得重复消费同一请求的费用。

专项覆盖：官方任务 CAS 与重启、消息已接收但尚未确认的去重、未接收消息冷恢复准入、预算/工具/取消拒绝、费用未知、重复调用、真实 stream drain、缓存 token 计费及持久化完整性。测试使用本地模型协议夹具。

新增闭包与许可证：`upstream-review.json`；先前 capability 证据保存在 `before/`。

验证结果：专项测试 88/88 通过（`focused.tap`），模块边界及上游依赖检查通过；能力回归 18 组、345/345 通过，当前源码绑定报告已保存。完整 `npm run check` 执行完全部 74 个集成测试文件，408 通过、1 失败，零跳过、零取消（`check.log`、`check-summary.json`）。唯一失败为指定 Windows 10/i7-7700 性能验收在本机 macOS/i7-9750H 上触发机器身份断言，保留原断言，因此完整检查退出 1。

首次能力检查遇到 macOS 临时目录符号链接限制，随后以 `TMPDIR=/private/tmp` 重跑；沙箱内 Electron 启动失败，允许本机窗口启动后重跑通过。此前尝试日志保留，未放宽任何测试。测试生成目录已归档并恢复本轮开始时内容，位置见 `generated-archive.json`；保留新能力报告。
