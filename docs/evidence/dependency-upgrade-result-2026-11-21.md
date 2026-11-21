# 2026-11-21 依赖与模型升级验证

本次按 Codex → Engine → UI → Harness 顺序实施，未修改相邻 milestones 的状态。原始审计和预检记录保留；本文件记录实际升级后的结果。

| 项目 | 当前冻结版本与来源 |
| --- | --- |
| Codex App Server | `@openai/codex@0.171.0`；483 个 JSON Schema、968 个 TypeScript 文件及树摘要同步冻结 |
| GPT | 使用账号实际返回的分页模型目录，支持 `gpt-6.2-astra`、`gpt-6.2-sol`；保留其他账号可用模型 |
| Engine / Extensions | 官方 npm `0.2.3`，tarball 经 integrity 校验后 vendored；Animation Spec `0.2.2` |
| UI | 干净源码 `f0f838af44a5f5dc86aa441cf517d7128d4e3f57` 的受审 `0.2.3` 候选；npm 尚无该版本 |
| Editor Shell | `0.1.2-ui.0.2.3` 本地兼容候选：只修改 manifest 版本与 UI 范围，35 个其余文件的字节保持一致 |
| Harness / Cordis | `dsh-v0.2.2-rc.5` / `4.1.0`，commit `9c2670d3bce5275e0d1610272958121af87787bb`；完整安装闭包保持精确版本与单实例 |
| Node | 最低 `24.9.0`，开发版本 `24.21.0`；本机 Electron 内置 Node `24.19.0` |

模型目录增加分页、刷新、账号切换失效和取消隔离；已保存但不可用的模型会明确提示，不会自动换模型。`xhigh` 与 `max` 分开保留，未准入的 Ultra 不会被映射。GPT 6.2 价格条目要求实际请求计费元数据，缺少 tier、缓存保留方式等事实时保持未知；订阅与 API 费用仍分开。

Harness 使用独立 NativeToolExecutor 与公开批调用接口，描述严格采用当前会话的 Studio 工具白名单，仍要求 Studio 审批票据。回归覆盖已注册及随后动态注册的未受审原生工具；恢复子会话的工具集保持空集。模型选择迁移到 Agent.model。旧 Team V2 邮箱以原始消息来源身份去重、追加收据并经过现有请求预算门禁，历史日志不重写，Team 产品准入保持关闭。上游新版 Web Fetch 允许内网地址；Studio 改用连接时检查 DNS 的公开地址 provider，保留匿名请求、同源重定向和响应大小/时间上限。

UI 候选执行了上游 typecheck（含 portable declarations）、122 项测试和 52 个入口检查。使用工作区隔离的 npm 11.6.4 作为打包工具：上游消费测试读取数组格式的 `npm pack --json`，npm 12 返回格式已改变。未修改 UI 上游源码。Studio 的标签页重连测试改为检查对应具名插槽；产品行为断言保留。

能力采集首次在 Windows 原生指针夹具发现失焦和画布重建后的异步 blur/reset。夹具增加 CDP 焦点仿真，并在每次重建后等待画布焦点及两个动画帧，再注入原生或回放手势；未改变产品的失焦清理，也未放宽坐标、渲染像素、相机一致性或 blur 取消断言。修复后的 40 次原生点击和全部拖拽/回放断言已单独通过，并纳入重新执行的完整能力采集。

实际安装命令为 `npm ci --allow-remote=all --cache .npm-cache --no-audit --no-fund`，最终干净安装 195 个包。显式完成 Electron、esbuild 和 spawn-helper 准备，node-pty/koffi 可加载。未修改全局 npm 或 Git 配置。

定向验证已通过：

- Codex/backend：28 项；运行时：118 项；编排层：238 项；Studio Shell：83 项。
- Harness：72 项；真实 Chrome Playwright / DevTools：4 项，包含取消初始化后重建。
- Engine：编辑器 62 项、脚本预览 41 项、物理/渲染/真实 WebGPU/Electron 19 项，包含正交/透视和原生指针拾取。
- UI：候选/Editor 准入通过，真实工作区桌面与窄屏、键盘、抽屉、重载流程通过。
- 契约：57 个 schema、60 个有效和 100 个无效案例；边界、上游 pin、协议 spike 及 quick eval 59 项通过。
- [GPT 6.2 真实冒烟](dependency-upgrade-codex-2026-11-21.json)：Astra、Sol 各完成文本、动态工具、问题回复、取消，共 8 项。

最终能力证据已刷新并复核：18 组、350 项通过，零失败、跳过或取消；与当前源码绑定。`npm run check` 完整执行 81 个集成测试文件，493 项通过、1 项失败，零跳过、取消，命令退出码为 1。唯一失败是 `m14-integration/product-electron.test.mjs` 的冻结设备门禁：要求 Windows 10.0.19045 / i7-7700 / 8 逻辑 CPU，本机实际为相同 Windows 版本 / i7-14700KF / 28 逻辑 CPU。产品创建和重启阶段通过；大项目阶段在设备匹配处停止，未取得受认可的性能测量。原硬件断言、1000 实体/200 脚本规模及全部时间/内存阈值均保留，未改写或跳过以得到绿色检查。

[机器可读最终结果](dependency-upgrade-result-2026-11-21.json)记录版本、当前源码摘要、真实测试数、失败项与日志摘要。本次生成输出已归档到 `.cache/dependency-upgrade-audit/integration-output`（146 个变化文件，含完整 TAP、结果 JSON、截图及清单摘要），随后恢复 Git 中原有生成输出，避免把历史证据覆盖成新结果。当前轮次全量生成文件的秘密扫描通过。完整总检查日志位于 `.cache/dependency-upgrade-audit/root-check-final.log`。

验证边界：当前没有声明的 DeepSeek 冒烟凭据，未进行真实 DeepSeek API 调用。Windows 尚无受审的受限 Node 执行适配器，已实测返回 unavailable；没有启用不受限执行。GPT 6.2 的输出上限仍受 App Server 现有能力限制，应用保留明确的降级诊断。后续需要在冻结的 i7-7700 基准机补跑性能门禁，并在安全配置测试凭据后补跑 DeepSeek 真实调用。此次验证不替代 M13/M14 正式多游戏矩阵验收。
