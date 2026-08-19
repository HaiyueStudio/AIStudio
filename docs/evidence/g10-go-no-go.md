# M06 POC go/no-go

结论（2026-08-19）：**技术 GO，正式 milestone 状态暂 HOLD**。

POC 已证明同一插件化编辑器可以替换 Harness 与 Codex backend，而不分叉 Scene、Document/History、工具、授权、日志或 Chat UI。
用户既能手工完成 Cube/Transform/脚本/预览，也能让真实 Agent 通过固定工具完成同一 revision-safe mutation。结构化日志对脚本故障、
stale revision、backend crash、plugin rollback、partial tail 和 restart 提供了可查询证据，且高风险路径在日志或授权不可用时 fail closed。

## Value and observed quality

- 两个真实 backend fixture 均成功，工具结果一致；本轮未出现 retry，端到端 real-agent smoke 约 27 秒。
- Electron profile smoke 分别约 43–57 秒，包含 WebGPU device-loss recovery、脚本 fault、两次 renderer load 与 teardown，不能视为普通启动延迟。
- deterministic operation-log workload（隔离 runner）：append p95 `20.52 ms`、flush `1.89 ms`、query `4.46 ms`、recovery `30.37 ms`，
  200 retained events、journal `116470` bytes、0 retained file handles。
- 真实集成发现并修复一项 Node-only smoke 无法发现的 Electron/Codex child 启动缺陷，说明双 profile 的 app-level 验收有实际价值。

## Safety and productization gaps

- 当前是 Windows 本地开发 POC；API key 依赖外部本机 secret owner 注入，尚无产品化 DPAPI/keychain 配置表单、轮换和恢复 UX。
- conversation projection 在 renderer reload 内可重放；跨 app restart 的排错以 durable Operation Log 为准，不承诺恢复完整聊天文本。
- Chat 的 question/plan 基础节点已具备，但复杂多选/自由补充、附件/素材上传、长期会话与多项目均明确在 M06 non-goals 外。
- trusted-project script 不是恶意代码 sandbox；产品版仍需更强 capability policy、项目信任 UI 与攻击面审计。
- Codex dynamic tool seam 与 DeepSeek Harness 都是固定 prerelease/pinned adapter，升级必须重跑 schema/compatibility suite。
- POC 没有生产安装包、自动更新、遥测、崩溃 dump、可访问性完整审计或大项目性能数据。

## M07 candidates

1. OS-native credential vault 与认证设置页，保留 main-process-only secret ownership。
2. durable conversation index、跨 app restart 的安全 replay 与会话压缩/retention。
3. 结构化 question/plan 编辑器：逐项确认、补充细节、冲突/不确定性显式化。
4. 素材导入作为独立受控 capability（病毒/格式/版权/配额检查），不扩大为任意文件工具。
5. product-grade Play realm、capability grants、crash dump redaction、soak/latency telemetry 与 Windows packaging。
6. upstream update bot 只生成 candidate 与 compatibility report，不自动提升 pin/baseline。

## Formal completion hold

当前 G10/M06 尚不应标记 `complete`：本轮实现尚未由用户提交为 clean reviewed revision，而 G10 contract 明确要求正式 evidence
绑定同一 clean revision。提交后需在该 commit 上至少复跑 `npm run check`、`npm run g10:evidence:check`、app tests、两个真实
backend smoke 与 `git status --short` clean 证明；全部仍绿即可把 G10 和 M06 更新为 `complete`。
