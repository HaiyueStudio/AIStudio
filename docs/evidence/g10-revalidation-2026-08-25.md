# G10 integration acceptance revalidation — 2026-08-25

结论：**NO-GO（单一机器级阻断）**。实现证据绑定 clean commit
`aff013539c08972ce5c28e44117933c775072579`；验收记录随后单独提交。旧的 2026-08-19 `GO` 是历史基线，不能代表当前版本。

## 已通过

- 根 `npm run check` 全绿：35 schemas，33 valid fixtures，22 invalid fixtures；typecheck、boundary、upstream pin、协议 spike 均通过。
- 10 个 package 共 127/127：包含 plugin activation 原子回滚、100 次 profile replacement、后端崩溃/重启、日志 partial tail/checksum/rotation/disk-full、审批拒绝/取消/5 分钟到期/stale race、脚本异常、tool timeout/cancel/late result、restart replay 与幂等 teardown。
- app 聚焦测试 25/25：凭据迁移 fail closed、跨 app 会话重建、budget hard stop、IPC 路径隔离、CSP、安全 preload、预览 one-shot broker、Web saved/draft 隔离。
- 真实 DeepSeek Harness 与 Codex 均使用 production tool seam 完成 `entity.create → transform.set`，revision `3`；DeepSeek 为 `deepseek-v4-flash/low`，Codex 为 `gpt-5.6-sol/low`，两者 terminal 均为 `completed`，无凭据持久化。
- Codex 内置浏览器真实 WebGPU 黄金路径通过：new → Cube → select → Transform → Undo/Redo → save → new → open，保存实体正确恢复且 Web UI 明确显示 `WebGPU · Web`。
- 现场验收发现并修复 Web `project/new` 覆盖 saved slot 的缺陷。新项目现在只更新 draft，且新增功能回归测试。
- bug bundle 新增离线 verifier：校验路径边界、manifest、逐文件 bytes/SHA-256、总 content digest、JSONL schema、事件/工件计数、sequence、correlation 和 canary；篡改 artifact 会以 `bundle.verify-file-digest` fail closed。
- `npm audit --json`：132 dependencies，0 vulnerabilities。

## 未通过

两个真实 Electron smoke 均在应用断言前失败：GPU subprocess 连续以 `-1073741515`（`0xC0000135`）退出。

1. sandboxed preload/desktop renderer smoke：0/1。
2. browser-host-in-Electron WebGPU smoke：0/1。

已排除父进程 DeepSeek 环境变量污染；smoke 现在主动移除两个 API-key env 名。关键 VC++、D3D、DXGI DLL 存在，GPU 为
NVIDIA GTX 1070 Ti，driver `560.94`。禁用 GPU sandbox 的诊断启动不再出现同一 GPU exit，但 renderer 随后销毁；该安全降级不满足验收，也未计为通过。

## 修正的旧证据

- 当前 UI 是 `0.1.1`，不是旧 manifest 的 `0.1.0`。
- pending approval 当前有 `300000 ms` 到期，不是“无时间限制”。
- conversation 当前可由 durable artifacts 在 app restart 后重建最终 projection，不再仅支持 renderer reload。
- 当前 tool catalog 是 14 个 bounded capabilities；profile composition 仍为 13 个 common plugins。

## Go/No-Go

用户价值、真实双 backend、工具安全、日志完整性、问题包脱敏、故障恢复和 owner teardown 均已成立；但 G10 明确要求真实 Electron/WebGPU E2E。
因此在修复/更换 Electron runner 的 GPU 加载环境并在同一 implementation commit 上复跑 2/2 Electron smoke 前，不得恢复 `GO`，也不得以软件渲染、`--disable-gpu-sandbox` 或浏览器通过替代。

机器可读证据：`docs/evidence/g10-revalidation-2026-08-25.json`；校验：`npm run g10:evidence:check`。
