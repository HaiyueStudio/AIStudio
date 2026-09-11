# 桌面通知与提示音

设置中的“通知与声音”提供系统通知、提示音和“仅在后台提醒”开关。默认启用通知与声音，前台和后台都提醒；已有设备的显式偏好继续保留。偏好保存在 Electron userData 的 `preferences/notifications.json`，不写入项目。测试通知允许前台触发，每三秒最多一次；界面会等待异步投递结果，区分已显示、未确认和失败。

需要权限审批、确认计划、补充信息，以及任务完成、失败或阻塞时提醒。普通 turn 的 completion 事实在会话完成收尾、busy=false 后触发“本轮执行已结束”，不把 turn 完成当作任务验收成功。与同轮任务完成合并为一次提醒；单个工具完成、自动续跑中的中间状态和取消不产生成功提醒。历史载入保持静默，重复事件去重；解决审批、过期、切换项目或卸载会撤回提醒。最多保留四条，每条最多五分钟。

点击通知会恢复并聚焦编辑器，校验当前项目后定位对应审批、completion 卡片或任务。点击不会批准权限、回答问题或继续任务。系统通知只包含固定事件类别，不包含项目名称、用户提示、工具参数或路径。

`agent-orchestration` 的 `ConversationAttentionTracker` 读取已有会话投影识别事实；应用层 `DesktopNotificationService` 管理设备偏好、去重、提醒生命周期和点击目标；`electronNotificationPort` 提供平台效果。通知、计时器、Dock 请求和窗口监听器均由现有应用生命周期释放。

后台提醒会同时触发图标效果，无需等待通知失败：macOS 使用约一秒的 informational Dock bounce，其他平台使用窗口任务栏闪烁；聚焦、撤回或关闭时取消。图标效果不抢焦点，前台不触发 Dock bounce。通知关闭时这些效果也不触发。

macOS 原生通知使用系统 Glass 提示音，静音开关传递为 silent。Windows 使用系统默认通知音及应用自己的 AppUserModelID/开始菜单快捷方式。通知投递失败或系统不支持时，保留图标提醒，并在声音开关开启时播放一次系统 beep；静音时也禁止降级声音。系统音量决定是否能听见声音，系统通知权限及勿扰设置决定横幅是否出现。

macOS Electron 的 UNNotification API 要求应用签名。直接运行未签名的 npm Electron 二进制会报告支持通知，但实际发送失败。先构建应用，再通过 `npm start` 启动：启动器在忽略目录 `.cache/desktop` 复制运行时，使用稳定的 `studio.haiyue.ai.development` 身份本地 ad-hoc 签名，并校验签名后复用。不会修改 node_modules；这不是分发签名或公证。正式分发仍使用正式应用签名。系统首次询问时需要允许 HaiYue AIStudio 通知。

2026-09-11 本机验证：未签名运行时返回 `UNErrorDomain 1`；本地签名运行时返回 `notification:shown`。该回调证明原生投递，不等同于人工听见提示音。回归覆盖前后台策略、静音、投递失败反馈、turn 收尾/去重、历史静默、审批撤回、Dock/任务栏清理及真实设置窗口。自动化回归使用 `HAIYUE_STUDIO_DISABLE_NOTIFICATIONS=1`，不弹出实际系统通知。

本次验证结果：通知服务/平台端口 8 项、会话提醒 9 项、真实设置窗口 2 项、项目会话 4 项均通过。能力快照的 12 组/123 项全部通过。`npm run check` 的契约、类型、边界、上游依赖、快速评估、行为、工作区、工具和逻辑检查通过；最终 46 个集成文件中 218 项通过、2 项失败，无跳过。图表悬浮面板在鼠标移入/移出断言上失败，单独重跑仍失败；组合产品窗口首次在 Gizmo 拖拽处超时，重跑通过该步骤后被既有 Windows/i7-7700 性能基准的主机断言拒绝。两处不涉及通知代码，保留原断言和预算，不把本轮声明为全绿。当前日志保存在 `/private/tmp/haiyue-notification-*.log`，集成输出备份到 `/private/tmp/haiyue-notification-verification/integration-output`，仓库中的历史输出保持原样。
