# 工程编辑的自动审批与授权复用

日期：2026-11-21

## 现象与根因

对桌面 `match3` 工程执行记录做了只读审计。审计快照包含 10,357 条事件、197 次工具准备、58 条授权请求事件和 27 次“始终允许”决定。其中 `component.configure` 有 23 次“始终允许”，全部来自同一个后端会话，但涉及 23 个不同实体。授权请求数包含挂起后重新准备同一操作，不能直接当作用户点击次数。

原授权摘要包含 `documentId + backend sessionId + tool/version + effect/risk + target`，所以“始终允许”实际上只允许当前实体。内存授权还会随应用重启丢失；持久恢复把所有授权（包括 allow-always）当作精确的一次性许可消费。重复后端续跑因此继续弹窗。

Codex 子进程的权限与 Studio 工具权限是两个边界。当前 Codex 只读沙箱及禁用内置副作用工具的限制保持原样。只修改 Codex 的 reviewer 配置无法修复 Studio 的授权卡片。

## 产品默认值

桌面应用默认采用 `auto-review`，聊天面板可切换到“逐次确认”。有效配置保存在本机 Electron userData 的 `agent-approvals.json`；工程审计中的模式变更事件不被当作配置恢复。缺少配置采用产品默认值，损坏或未知版本配置回退为 `ask`。模型工具不能修改此设置。未注入产品策略的 headless host 保持显式确认。

`ask` 关闭规则式自动审批，仍沿用用户已经明确授予的工具许可；切换审批方式不是撤销已有“始终允许”授权。

自动审批必须同时满足：

- 当前任务已有用户批准的方案，当前 turn 属于该方案；
- 当前工程和 Document 与任务及已准备操作一致；
- 工具是本地注册的 `reversible-edit / medium` 操作，并提供有效的工程工具授权摘要；
- 不属于 `official.*` 外部工具。

Host 先持久记录 `conversation/approval-auto-reviewed`，再给予当前 preparation 精确的 `allow-once`；不创建人类等待屏障，也不产生隐式的长期授权。审计写入失败或取消时停止。执行时仍重新检查 revision、参数摘要、预览摘要及生命周期，仍使用同一 Document/History 提交路径。

批准方案后 `script.apply` 的现有授权规则保留。首次 `play.start / preview.start`、新代码、外部副作用和预算扩张继续使用显式确认。已确认且内容未改变的预览沿用现有 preview-consent。真正缺少的事实和用户偏好问题仍等待回答。提示词明确要求直接调用已授权任务所需工具，不在聊天中重复索要相同许可；提示词不承担最终授权裁决。

## “本工程始终允许”

仅对可复用的本地 `reversible-edit / medium` 工具显示此动作。

新摘要绑定 `projectId + documentId + registryDigest + hash(projectRoot) + toolId/version + effect/risk`，不再包含实体 target 或后端 sessionId。因此同一工程中更换实体、后端会话或任务不重新询问。应用存活期间保留工程工具授权；重启后只在原任务的持久恢复中沿用。工程位置、组件契约或工具版本变化会使摘要不同。

恢复时，新 `project-tool` 授权仍须匹配原 task、Document、工具、effect/risk 和摘要，可重复沿用，不按单个操作标记 consumed。旧 `project-session` 和一次性授权继续按原目标、revision 和摘要精确匹配并单次消费，不扩张历史授权。新摘要无效时不得回退为宽授权。

## 与“帮我审批”的关系

交互目标参照 [Codex Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) 和 [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)：在保留执行边界的前提下，减少用户批准正常工作的次数。

这里实现的是确定性的 Studio 本地规则，不是接入 OpenAI 的自动审批模型，也不宣称两者风险判断完全相同。当前工具集没有通用 shell、任意文件、网络或软件安装能力；未来增加这些能力时必须单独评审其策略，不能继承可撤销编辑的默认规则。

## 验证范围

- 契约有效、无效、未知版本和携带额外 secret 字段的样本；本机偏好默认值、持久化、损坏回退和 dispose。
- 同一方案连续编辑不同实体自动通过；逐次确认、首次 runtime start、外部工具继续等待；审计失败不执行。
- 工程工具授权跨实体、后端 session 复用；工程切换及过期 revision 不执行。
- 持久授权挂起、Host 重建、后端 continuation；一次性授权消费一次，新的工程工具授权不被误消费。
- 真实 Electron 生产窗口的默认模式、通过 typed preload 切换、配置落盘及 renderer reload。

不修改 `match3` 工程、历史授权事实、milestone 状态或冻结的基准硬件要求。
