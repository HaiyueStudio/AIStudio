# G10 integration acceptance revalidation — 2026-08-25

结论：**GO**。实现证据绑定 clean commit
`cf3018b051776d90b1241c32453d615eefa104f2`；验收记录随后单独提交。旧的 2026-08-19 `GO` 是历史基线，不能代表当前版本。

## 已通过

- 根 `npm run check` 全绿：35 schemas，33 valid fixtures，22 invalid fixtures；typecheck、boundary、upstream pin、协议 spike 均通过。
- 10 个 package 共 128/128：包含 plugin activation 原子回滚、100 次 profile replacement、后端崩溃/重启、日志 partial tail/checksum/rotation/disk-full、审批拒绝/取消/5 分钟到期/stale race、脚本异常、tool timeout/cancel/late result、restart replay 与幂等 teardown。
- 新增确定性修复闭环：预览故障与项目保存后重启，Agent 经 `diagnostics.query` 读取旧的脱敏 `preview/runtime-error`，提出完整脚本并只在一次性 `script.apply` 审批后提交；revision 从 `3` 精确增至 `4`，审批与 Document/History correlation 可追溯。
- app 聚焦测试 25/25：凭据迁移 fail closed、跨 app 会话重建、budget hard stop、IPC 路径隔离、CSP、安全 preload、预览 one-shot broker、Web saved/draft 隔离。
- 真实 DeepSeek Harness 与 Codex 均使用 production tool seam 完成 `entity.create → transform.set`，revision `3`；DeepSeek 为 `deepseek-v4-flash/low`，Codex 为 `gpt-5.6-sol/low`，两者 terminal 均为 `completed`，无凭据持久化。
- Codex 内置浏览器真实 WebGPU 黄金路径通过：new → Cube → select → Transform → Undo/Redo → save → new → open，保存实体正确恢复且 Web UI 明确显示 `WebGPU · Web`。
- 两条真实 Electron/WebGPU smoke 均通过：sandboxed desktop renderer/typed preload 约 `43.21 s`，browser-host-in-Electron 约
  `3.85 s`；两者均保留 renderer sandbox、GPU sandbox、context isolation、`nodeIntegration:false` 与真实 WebGPU。
- 现场验收发现并修复 Web `project/new` 覆盖 saved slot 的缺陷。新项目现在只更新 draft，且新增功能回归测试。
- bug bundle 新增离线 verifier：校验路径边界、manifest、逐文件 bytes/SHA-256、总 content digest、JSONL schema、事件/工件计数、sequence、correlation 和 canary；篡改 artifact 会以 `bundle.verify-file-digest` fail closed。
- `npm audit --json`：132 dependencies，0 vulnerabilities。

## Runner boundary resolution

首次从 Codex 工作区命令沙箱内启动时，两个 Electron smoke 的 GPU subprocess 都以 `-1073741515`（`0xC0000135`）退出。
PE 递归检查确认 Electron、ANGLE、D3D 和 NVIDIA 静态加载链无缺失；关闭 GPU sandbox 的诊断会改变安全边界，因此没有计为通过。

随后在授权的外层非工作区沙箱 runner 中，以**未修改的测试、未增加 Electron flags、未关闭任何 Electron sandbox、未使用软件渲染**
复跑，desktop 与 Web-host smoke 2/2 通过。这证明失败来自外层 Codex 文件/进程沙箱无法供 GPU child 读取 DriverStore，并非产品、驱动或应用安全配置缺陷。
以后 Electron GPU E2E 必须沿用该 runner boundary，普通 Node/package 测试仍在默认工作区沙箱内执行。

## 修正的旧证据

- 当前 UI 是 `0.1.1`，不是旧 manifest 的 `0.1.0`。
- pending approval 当前有 `300000 ms` 到期，不是“无时间限制”。
- conversation 当前可由 durable artifacts 在 app restart 后重建最终 projection，不再仅支持 renderer reload。
- 当前 tool catalog 是 14 个 bounded capabilities；profile composition 仍为 13 个 common plugins。

## Go/No-Go

用户价值、真实双 backend、工具安全、日志完整性、问题包脱敏、故障恢复、owner teardown、浏览器 WebGPU 与真实 Electron/WebGPU
均已成立。无 secret/tool bypass、log integrity failure 或 owner residual no-go，结论恢复为 `GO`。

机器可读证据：`docs/evidence/g10-revalidation-2026-08-25.json`；校验：`npm run g10:evidence:check`。
