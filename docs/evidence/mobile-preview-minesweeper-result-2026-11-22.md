# 局域网扫码预览与扫雷修复卡点

日期：2026-11-22；网络范围经用户确认：同一 Wi-Fi / 局域网。

预览页新增“扫码运行”，采用 UI 库公共二维码组件，启动内置 HTTPS 服务。手机访问后点击开始，在自己的浏览器中独立运行当前已授权的游戏快照。提供地址切换、复制链接、证书下载与指纹、停止分享、30 分钟到期、手机重玩/全屏/退出。服务不会自启动，也不承载编辑器 IPC 或项目写入。停止 Play、修改工程或应用退出都会撤销分享。

首次使用需在手机安装并信任本机预览 CA；iOS 安装后还需启用完全信任，见 [Apple 官方说明](https://support.apple.com/en-us/102390)。未在实体手机上执行扫码与信任安装；已验证真实 Chromium HTTPS、安全上下文、WebGPU、生产隔离运行页和分享撤销。浏览器需支持 WebGPU，防火墙及 Wi-Fi 的设备隔离策略需允许访问本机临时端口。当前固定使用生成二维码时的画布比例，游戏自身仍需设计触屏交互。

## 扫雷记录中的两个独立卡点

只读分析 `C:\Users\Administrator\Desktop\minesweeper` 的保存工程、两轮会话与证据。保存工程 revision 10、112 个实体、一个脚本 textRevision 2。读取前后工程文件 SHA-256 为 `583b141d692e238e45d255982af7e822194ac08705f6c3ccd994f53d9ce0a468`。没有修改原工程、脚本、日志或历史验收结果。

1. **真实浏览器按键没有完整传给脚本。** Pointer Events 在第一个键按下后，把其他键的变化编码为 `pointermove(button, buttons)`。原 `preview-runtime.installInput` 在转发 move 时删除 button，也没有根据 buttons 生成对应的按下/松开。第二轮脚本已经尝试根据带 button 的 move 补偿，但真实链路不会提供该字段。
2. **第二轮验收方案的字段路径错误，而且重试没有改变已批准方案。** 2026-11-22 12:07:05.561 和 12:07:12.261（北京时间）的两次 `task.evaluate` 均报告 `evaluation.signal-missing:entities.0.materialColor.0`，其余 9 项通过。证据 `artifact:sha256:776ac1cd3fb8a46ad37c012c4908d3ceaa9ae331ab8ec3619f40244a1979ff0e` 中，目标格的颜色实际存在于 `payload.state.entities[0].materialColor[0]`，值约 0.117647，满足 `<= 0.12`。正确断言为 `evidence state signal state.entities.0.materialColor.0 lte 0.12`。第二次工具参数已改成正确路径，但 `ConversationHost` 按设计强制使用已批准 TaskSpec，仍执行原错误路径。应修订并重新确认验收方案，不能靠反复执行工具、重写游戏或在 gameplay 中伪造同名字段解决。

两轮记录包含 60 次 `play.input`、24 次 `play.inspect`、20 次 `play.step`、3 次 `task.evaluate`。第二轮在 12:02:12.718、12:02:39.255 直接注入了 `phase: move, button: 2`；此入口从模拟层进入，绕过发生丢失的 DOM 适配层。因此脚本层的 chord 状态通过，不能证明实体鼠标操作也通过。第一轮整体评估通过；第二轮是上述颜色路径的评估失败，不应描述成两轮所有自动验收均通过。

## 本轮修复与验证

通用输入桥增加按 pointerId 维护的按钮掩码，将组合按键变化规范化成已有逻辑 down/up，覆盖左右键不同按下与松开顺序。保留普通移动、滚轮、动作映射、取消/失焦和销毁边界。取消释放映射动作但不生成正常抬起点击。项目脚本和 Engine Replay 格式均不需要改写。

原扫雷工程仅复制到仓库 `.cache/mobile-preview/minesweeper-run`，经真实 Workspace 与脚本验证器生成运行数据，使用生产 HTTPS 手机页面和 Chromium 原生输入分发验证。未调用 `play.input` 或付费模型。四组顺序均通过：

| 先按 | 先松 | 旗数不足 | 旗数匹配 | 组合操作后的右键 |
| --- | --- | --- | --- | --- |
| 左键 | 左键 | 不翻格 | 翻开安全邻格 | 正常撤旗一次 |
| 左键 | 右键 | 不翻格 | 翻开安全邻格 | 正常撤旗一次 |
| 右键 | 左键 | 不翻格 | 翻开安全邻格 | 正常撤旗一次 |
| 右键 | 右键 | 不翻格 | 翻开安全邻格 | 正常撤旗一次 |

每组检查首击安全、旗数、翻开数量增加、未翻到地雷、相应 `chord-mismatch` / `chord-open` 语义，以及真实 DOM `isTrusted` 的中间 pointermove。脚本保持保存版本 textRevision 2。

新增回归覆盖 CA 校验、私钥加密、资源摘要/路径投影、Host/Origin/路由边界、授权与修订绑定、尺寸变更、并发启动和取消、超时/销毁、原生鼠标组合键、HTTPS WebGPU 运行/重玩/撤销，以及生产 QR 弹窗的组件渲染、地址切换、过期与延迟结果处理。已有相机输入测试窗口移出物理鼠标范围并等待画布取得焦点，避免桌面鼠标运动污染原生输入与回放比较，原断言保持。

定向普通检查 30 项通过；完整编辑器 smoke、手机 HTTPS 页面、QR 弹窗和相机拖动检查分别通过。能力检查 20 组、394 项全部通过。

`npm run check` 前置检查全部通过；89 个集成文件执行了 526 项，525 项通过、1 项失败，无跳过或取消。唯一失败为现有 `m14-integration/product-electron.test.mjs` 的 `one native gesture history transaction` 超时；单独复核仍为同一超时，与仓库原先保留的 `test-output/product/author/author-failure.json` 诊断一致。该测试未进入 large 阶段，本轮不把它描述成硬件冻结断言失败。未修改产品窗口测试或放宽断言，也未将完整检查标记通过。新增三份集成文件共 8 项全部通过。

生成证据敏感信息扫描通过：688 个文件、407,402,328 字节、无 crash dump。当前输入摘要为 `sha256:2c454e6d649bd80e4b9d69c0e688970bd3bfb61fe82485413becec217f19fba7`。本轮完整结果与原始失败归档于 `.cache/mobile-preview/integration-output`，复核日志在 `.cache/mobile-preview/product-recheck.log`，截图在 `.cache/mobile-preview/screenshots`；受控 test-output 已恢复历史基线。汇总见 [JSON](mobile-preview-minesweeper-result-2026-11-22.json)。不推进 milestone；架构与使用边界见 [ADR 0006](../adr/0006-https-mobile-preview-and-pointer-chords.md)。
