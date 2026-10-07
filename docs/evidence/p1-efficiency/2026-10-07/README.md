# P1 交互与效率验证（2026-10-07）

本轮实现对应最新完善方案的四个 P1 工作包。基于未提交的 P0 修复继续开发；没有覆盖 P0 历史证据，没有提交、推送或修改里程碑状态。

## 实现与边界

1. 问题绑定已批准步骤及其依赖闭包，拦截相关步骤进度和候选委派；仅证明实体 scope 独立的已批准 transform/material 工作可在等待期间继续。答复已入队仍是写入屏障。
2. 官方大结果保存脱敏原件，交付摘要/来源/引用；按段读取和匿名网页抓取复用绑定 session、document revision、权限与期限。工具结果账本记录真实输入输出字节。搜索、浏览器和 Node 不缓存执行。
3. 设备工具偏好、后端选择、Main 环境检测、不可用原因进入设置页；重启生效。模型只获得可用能力及允许参数，原生 schema 漂移检查仍完整。
4. 产品接入 W7 候选入口、构建绑定资格证据包、最小事实、共享预算、可见子任务状态、真实退出取消与父任务核验。不会创建第二套持久任务，也不启用官方 Team。

## 已完成的定向验证

- `focused.log`：37 项通过，覆盖既有 P0 异步恢复、W7 预算/候选/取消和新增结果引用/设置边界。
- `targeted.log`：4 项通过，含 Host 实际问题依赖及已答复待续跑屏障。
- `official.log`：10 项通过，含 native receipt 和模型 schema 裁剪。
- `real-tools.log`：7 项通过，实际 Playwright / Chrome DevTools / restricted Node 进程，仅本机测试页面与固定脚本。
- `dedupe.log`：2 项通过。真实 Host + Harness Messages mock 的同输入抓取对照：开启复用后 provider body 执行 1 次；关闭为 2 次；原始正文保持完整、摘要小于原件一半、引用可读取。该证据证明调用及传输减少，**不是生产 token 收益或真实 provider A/B 资格**。
- `last-focused.log`：设置、CAS 引用和资格包加载/拒绝合成证据的补充检查。
- `final-consistency.log`：最终源码与能力报告绑定检查、边界检查通过；`git diff --check` 无问题。
- `boundaries.log`：单一 Harness Bridge、无 renderer 平台执行、headless orchestration 及跨仓库边界检查通过。
- `ui-final.log`：真实 Electron 设置交互通过，截图为 `tool-settings.png`；检查开关、后端、不可用原因、保存/重启提示、语言切换和释放。
- `final-focused.log`：最终产品源码下的 12 项相关定向回归通过。

这些测试有覆盖重叠，不能相加当作独立用例总数。`regression.log` 保留初次大并发运行的失败：两个旧项目回放测试超时，在串行复测中通过；原 deduplication 断言仍要求发送完整正文并执行两次，与本轮引用复用行为不符，现改为校验 CAS 原文、片段读取和实际执行一次（`dedupe.log`）。没有放宽产品时间限制。

## 发布检查

根目录 `npm run check` 已运行到底：74/74 集成文件执行，407 项通过、2 项失败、0 跳过/取消。之前的契约、类型、边界、版本、能力、工作区、工具与逻辑检查均通过。原始完整检查为 `check-before-render-readiness.log`，全部集成 TAP 与汇总在 `integration-before-render-readiness/`，其输入绑定为 `sha256:904aeb95c183dc409dd6557ec3706905cf1bac724d156f2e9a745d4d7e717c8c`。

两项失败：

- `product-electron` 要求 Windows 10 / i7-7700 / 8 逻辑核，本机为 macOS / i7-9750H / 12 逻辑核。未伪造平台信息或放宽机器要求。
- `material-cursor-electron` 截到了纹理尚未呈现的占位帧，空颜色集合导致越界；单独复现也失败。最终**只修改测试 fixture**：空颜色集合有安全结果，作者视图与 Play 均等待真实材质信号再比较；保留原颜色阈值、像素一致性、指针对齐和总超时。`material-fixed.log` 复测通过（两侧 dominant 均为 `[167,139,89]`，指针/清理通过），前后截图已归档。

该完整检查记录不会被改写为全绿。最后一次 fixture 改动后的完整根检查未重复；已对改动文件运行定向检查，并重新实际采集绑定最终输入的能力证据。生产实现与此前完整检查相同。最终 capability 重新采集完成：18 组、345/345 通过，绑定 `sha256:9ace0695ed04e961fab32f521c3f3e6112fd6f7ae91abad218ce5d000e301448`，见 `capability-final.log` 及当前两份能力报告。未将旧结果重写为新源码的结果。

运行生成的设备输出已完整归档至 `generated-archive.json` 指定的本机目录，原 test-output 恢复到本轮开始时内容；P0 源码与历史报告保持不变。`before-*` 是开始本轮前的 P0 正式能力报告，禁止覆盖历史报告假装新源码已经验证。

本轮没有调用付费模型、没有制造真实 A/B 资格证据。并行默认关闭，用户设备须提供与当前构建/模型/profile/registry 匹配的真实测量包后才能参与每次准入检查。P0 已记录的指定 Windows 设备性能门禁仍需在指定设备执行；macOS 测试不能替代该门禁。
