# M06 POC evidence plan

G01 只冻结 fixture 和验收方法，不生成产品通过证据。Fake backend 用于确定性 CI；真实 backend、WebGPU、crash/restart
证据只能在对应 Goal 的真实 Windows/Electron runner 上产生。

## Deterministic controls

- clock 起点：`2026-08-19T00:00:00.000Z`，每个 durable event 前进 1 ms。
- ID：按类型单调生成 `session:0001`、`turn:0001`、`step:0001`、`toolcall:0001`、`event:000001`。
- 同一 document mutation 串行；fake stream 序列固定；取消点在 tool result 返回前。
- secret canary：测试时只使用 `HAIYUE_SECRET_CANARY_DO_NOT_PERSIST`，证据扫描必须为零命中。

## Creative fixture: `tiny-orbit`

用户请求：创建一个 Cube 作为 Player，位置 `(0, 0, 0)`；创建 Empty 作为 Rotator，位置 `(0, 1, 0)`；给 Player
添加经校验的脚本，使预览时围绕 Y 轴缓慢旋转。

Expected state after approved commit:

- document `document:tiny-orbit` 从 revision 0 到 revision 3；保存后 `savedRevision=3`、`dirty=false`。
- entities：`entity:player`/Cube transform `[0,0,0]/[0,0,0]/[1,1,1]`；`entity:rotator`/Empty transform
  `[0,1,0]/[0,0,0]/[1,1,1]`。
- script `script:player-orbit` 绑定 Player；写入 proposal 与首次 preview 是两个 approval，digest 与 revision 均匹配。
- History labels：`Create Player`、`Create Rotator`、`Attach player-orbit script`；Undo/Redo 后 Document 与选择投影一致。
- correlation：turn → plan steps → tool calls → approvals → commands → transactions → revisions → preview session 可遍历。

Manual acceptance:

1. 手工创建/选择 Cube 并编辑 Transform，保存、关闭、重开。
2. 分别选择 fake、Harness API-key、Codex App Server backend 执行相同请求；仅 backend/auth 节点不同。
3. 检查每项计划可逐项确认或补充；拒绝一次脚本 approval 后不发生写入，再以新 proposal 批准。
4. Play 后观察旋转，Stop 后 runtime state 不回写；Undo/Redo 后重启仍能从日志解释 revision。

## Failure fixture: `broken-orbit`

- 在 tool prepare 后、approval 前插入另一条 Transform command，制造 stale base revision；旧 approval 必须变为 `stale`。
- 第二次脚本 proposal 引入未定义符号 `spinSpeedTypo`，validation 返回定位到 script id/line/column 的 diagnostic。
- 在 durable event 尾部注入半条记录并重启；recovery 截断 partial tail、保留最后 verified sequence 并记录 recovery event。
- 模拟 Codex 在 pending tool 时退出；turn 进入 interrupted/failed 终态，迟到 result 不提交，child process owner 清零。
- Agent 只能通过 `diagnostics.query` 的 session/turn/script/correlation filter 找到根因，不能读取任意路径。

Expected diagnosis: `script:player-orbit` 的 validation failure 是 preview 未启动的直接原因；stale approval 是独立、已拒绝的
mutation，不应被误报为脚本错误。修复符号后产生新 script digest、新 approval 和新 revision。

## Evidence by Goal

| Goal | Required evidence |
| --- | --- |
| G02 | activation rollback、reverse teardown、double-dispose、late-result fixture |
| G03 | append/checksum/partial-tail/rotation/quota/redaction/restart query |
| G04-G06 | real Electron security config、save/reopen、WebGPU/picking、History、trusted preview lifecycle |
| G07-G08 | fake conformance + two real auth/turn/cancel/rate-limit flows、structured chat/approval/log UI |
| G09 | same tool fixture across backends、revision conflict、approval digest、Undo/Redo |
| G10 | one reviewed revision 的完整 golden path、secret scan、owner residual、bug bundle manifest |

No-go：fake backend 替代真实凭据、mock WebGPU 替代真实 viewport、合成日志替代 crash/restart，或任何证据来自不同 revision。
