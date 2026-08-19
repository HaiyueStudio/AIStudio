# G10 POC acceptance evidence

日期：2026-08-19。基础 commit：`c575ccf8ab5e21015ea963723325bd3116931c23`。本记录覆盖其上的 G05-G10
实现工作树；正式 M06 completion 仍需用户提交后在 clean reviewed revision 复跑总门禁。证据与 smoke 均在本机临时 project/user-data
目录生成，不提交项目、日志、截图、bug bundle 或凭据。

## Frozen composition and provenance

- `poc-editor-harness` 与 `poc-editor-codex` 共享 13 个固定 plugin id，只分别选择
  `harness-api-key/api-key` 与 `codex-app-server/chatgpt` 行。机器真值为 `g10-expected-manifest.json`，
  `npm run g10:evidence:check` 校验 profile、plugin、upstream pin 与四个 Editor tarball SHA-256。
- Node minimum/runner `22.19.0/24.19.0`，Electron `43.2.0`，Engine/UI/Editor minimum/latest/candidate
  均为 `0.1.0`。Harness 固定 `dsh-v0.1.0-rc.7@99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`、MIT；
  Codex CLI `0.148.0`，schema tree SHA-256
  `dc3613ce823c95087e660f8d12dac89856863eff653f2c8dd8f1ad0cac98ef11`。
- Runner：Windows 10 Pro `10.0.19045`，NVIDIA GeForce GTX 1070 Ti，driver `32.0.15.6094`，真实 WebGPU。
- API-key smoke 只从本机用户级 secret owner 读入 child env，child 结束后清空 process env；结果仅报告
  `credentialPersisted:false`。Codex 只走 pinned App Server/stdin 与其官方账号状态，不读取 credential 文件。
- Codex 未登录时的 browser/device-code handoff 由 Electron main 拥有；只允许 `https:` URL 交给系统浏览器，device code
  使用原生 dialog。renderer 不获得 token、Codex child 或通用 open/navigation 能力。

## Golden paths

| Path | Result | Evidence |
|---|---|---|
| Manual Electron | PASS | real Electron/WebGPU：create → pick → Transform → Undo/Redo → save/reopen；脚本 proposal/commit、独立 approval、Play/hot reload、注入 runtime fault、Stop、reload、PNG candidate。 |
| `poc-editor-codex` | PASS | backend state `ready`；完整 Electron path、Chat/Logs read model、reload 与 teardown 通过。Electron 专用测试发现并修复 `electron.exe` 启动 Codex JS entry 的问题，受控 child 现使用 `ELECTRON_RUN_AS_NODE=1`。 |
| `poc-editor-harness` | PASS | 已授权 secret owner 下 backend state `ready`；相同 Electron/WebGPU path 与 teardown 通过。 |
| Real Harness Agent | PASS | `entity.create → transform.set`，terminal `completed`，document revision `3`，凭据未持久化。 |
| Real Codex Agent | PASS | 与 Harness 相同 tool ids、最终 entity/Transform 和 revision `3`，凭据未持久化。 |
| Fake full tool path | PASS | create、Transform、script propose/apply、preview validate/start/stop；脚本写入和首次 run 分离授权。 |

Chat renderer 只消费 G08 validated replay read model 并发送 typed intent。Electron main 的 `StudioConversationHost` 唯一拥有 backend
stream、问题、approval 与 G09 tool service。Agent preview 使用一次性 broker 交给 renderer-owned isolated realm；stale ack、reload、renderer
crash 或 dispose 会取消 turn、approval 与 preview command，晚到结果不能提交。

## Failure, approval and lifecycle matrix

- Script exception：真实 isolated runtime 捕获 source/line/column、释放热重载 disposable，编辑文档不被 runtime mutation 回写。
- Stale revision/schema/approval race：spoof、reject、cancel、expire、revision drift 全部 fail closed，mutation count 为 0。
- Plugin activation：required/optional/config/late async failure 原子回滚；100 次 profile replace 无 owned resource。
- Backend disconnect/crash：malformed frame、process exit、turn crash 产生 terminal diagnostic；fresh pinned backend 可 restart。
- Log restart/fault：live/replay 等价；partial tail quarantine/recovery、checksum isolation、rotation/quota、legacy migration、disk-full
  structured failure、correlation cursor 均通过。
- App restart/reload：project save/reopen、renderer reload、preview realm teardown 与新的 authoring WebGPU owner 通过；Codex child、Worker、
  file handle、timer/listener/GPU owner 均走幂等 dispose。性能 fixture 最终 `retainedFileHandles:0`。
- Approval audit：reversible mutation、trusted script apply、runtime start 都绑定 exact args/preview digest、document/base revision、expiry 与
  one-shot decision；plan accept 不等价于 tool approval。
- Diagnostics：`diagnostics.query` 是 13-tool allowlist 中唯一日志入口，只返回 bounded safe summaries；Agent 无路径、SQL 或 raw journal。

## Log and bug bundle

Operation Log tests 在 restart 后重建 correlation graph，partial tail 会隔离而不是伪装成功。bug bundle 导出后二次脱敏，离线校验
`manifest.json`、`contents.json`、JSONL、artifact SHA-256、content digest 与 secret canary scan；approved artifact 必须 persist-before-reference。
Log Viewer IPC 只返回 payload digest、redaction count 与 allowlisted correlation，导出目录由 main 固定到 app user-data，renderer 不能提供路径。

## Commands passed

- `npm run check`
- `npm run g10:evidence:check`
- package functional/fault/lifecycle：59 tests（包括 Electron Node-mode regression），0 failure；Operation Log performance
  workload 按正式隔离 runner 单独执行：1 test，0 failure。曾将全部 test files 并发时产生磁盘争用，append p95 为
  `320.38 ms` 并正确失败；未提升 baseline，隔离复跑 p95 为 `20.52 ms`。
- app focused tests: profile/conversation/IPC/security/bundle tests，0 failure
- real Electron smoke：Codex profile PASS；Harness profile PASS
- real backend smoke：Harness PASS；Codex PASS
- `npm audit --json`：132 dependencies，0 known vulnerability

未更新 Engine/Editor API、pixel、CPU、GPU、gzip、fidelity、screenshot 或 performance baseline；PNG 只作为临时 candidate 验证签名和
最小尺寸。
