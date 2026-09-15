# 验收断言格式修复（2026-09-15）

报告的 `evidence state signal effects.unchangedEntityIds` 是合法 JSON 字符串里的不完整 DSL：缺少 operator/expected，而且字段不属于 effects 输出。不能通过猜测默认值、删掉 signal 或删掉验收条件来“修好”。

实现：

- 计划输入支持 `{type, signal, operator, expected}` 的结构化比较；批准和持久 TaskSpec 仍使用现有字符串契约。
- 批准前将 `==/>=/<=` 转为 `equals/gte/lte`；只在引号外移除合法值之后的尾随逗号，将多行预期 JSON 规范化为一行。规范化后必须再次通过解析和字段检查。
- 不猜测缺失值、类型或条件，不修复缺失数组元素；不存在的字段仍要求模型根据实际生产数据修正。
- 保留 `plan.payload-invalid` 的现有预算内纠错路由。紧凑模型结果也保留具体诊断和结构化重提指导；原失败尝试保留，纠错期间任务继续运行。
- 任何修改都在用户批准之前发生；既有批准标准不会被重写。

验证：专项 29 项通过（tests.log），包括报告原例回传模型/自动续跑、JSON 类型保留、无歧义格式修复、非法缺失值拒绝及原验收条件保留。模块边界检查通过。

应用构建通过；新增说明仍可通过文档工具在默认预算内读取。`git diff --check` 通过。

整仓 `TMPDIR=/private/tmp npm run check` 已执行，最终停在既有 M14 能力清单的 `stale verification input binding`（root-check.log），未重采样或绕过基线。不能声明整仓通过。应用未重启，新实现重启后生效。
