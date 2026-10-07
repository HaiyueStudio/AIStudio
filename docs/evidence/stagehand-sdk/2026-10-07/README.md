# Stagehand 4.1.0 自定义推理验证

结论：底层 SDK 已有可用的 `ClientLLM.generate`，无需 fork Stagehand。当前缺口是固定 Harness rc.2 封装仅接受原生 model 配置，未把自定义推理转交 Studio Host。本轮只提交可复现验证与隔离封装补丁，未安装生产依赖、开放产品入口或调用付费模型。

## 固定版本事实

审查对象为 npm 发布的 `@browserbasehq/stagehand@4.1.0` 与 `@deepseek-ai/dsh-experimental-browser-use-stagehand-native@0.2.0-rc.2`。包完整性、实际 SDK/扩展文件 SHA-256、42 个隔离依赖的许可证和 integrity 见 `upstream-review.json`；完整锁见 `packages/harness-bridge/spikes/stagehand-sdk/package-lock.json`。

- v4 API 为 `Stagehand.create({ browser, model: { generate } })`，导出 `ClientLLM` 和 `ClientLLMSchema`。v3 的顶层 `llmClient` 在这个版本被拒绝。
- SDK 把回调保留在本机，通过 `llm.generate` RPC 接收浏览器扩展推理请求；传给扩展的模型仅为 `{ source: 'client' }`，不必提供模型 API key。
- `generate` 支持文本和 JSON Schema 结果，返回的 usage 含 input/output/total/cachedInput/reasoning tokens。`act/observe/extract` 的 `metadata.usage` 为操作内聚合；`extract` 实测调用两次（Extraction、Metadata），不能假设一次工具调用等于一次模型调用。
- `generate` 的请求参数没有 AbortSignal、maxTokens/maxOutputTokens，也没有 Studio tool-call 身份。需由 Host 捕获执行上下文、限制单次与累计请求，并在 provider 请求上设置输出上限。
- SDK 对缺失 usage 的操作汇总会使用零值，不能作为 Studio 的计费依据。每次推理必须在 Host 独立结算；第二次推理失败仍需保存第一次的实际用量。

以上修正了此前只审查 Harness 声明而得出的“底层不提供用量或推理钩子”的判断。公开的 [v3 API 文档](https://github.com/browserbase/stagehand/blob/main/packages/docs/v3/references/stagehand.mdx) 有旧 `llmClient` 示例，本验证不以其代替固定 v4 发布包证据。

## 小范围封装补丁

`worker-client.patch` 与 `packages/harness-bridge/spikes/stagehand-sdk/patch-worker.mjs` 仅应用到隔离副本，原始 Worker 位于 `packages/harness-bridge/spikes/stagehand-sdk/native-worker.js.txt`，保留上游 MIT 许可证。补丁先校验整个原文件 SHA-256 和唯一替换位置，版本漂移立即失败。

补丁把原生 `model` 入口换成独立 `MessagePort`，在 Worker 内构造 `model.generate`；回调函数和 API key 都不跨 workerData。浏览器操作仍使用原有 Harness 参数校验及 execute 分发，模型参数不能通过工具调用覆盖。缓存关闭，测试遥测终点限定本机。测试专用的不可达 `assertNever` guard 改成本地 throw，避免为验证再安装 DSH 闭包；这不属于未来生产补丁所需变更。

`packages/harness-bridge/spikes/stagehand-sdk/host-gateway.mjs` 是**验证原型**：展示按工具调用归属、逐请求 admit/settle、输入字节/请求次数限制、输出上限传递、取消后等待实际生成结束，以及未知用量保留。它未接入生产 TaskAccount/UsageLedger、持久请求去重、恢复与精确审批；不能直接作为正式工具启用。

正式接入应将此通道归属现有浏览器 Session 生命周期，把 admit/settle 接到现有 Tool Host 和父 TaskAccount，逐请求使用稳定身份写持久记录；超时/Worker 退出取消 Host 生成并等待结束，未知费用保持预留。只由 Host 持有模型凭证，禁止原生模型或逐操作模型覆盖回退，避免绕过预算。SDK 汇总仅用于核对，不能再次入账。

## 复现

将仓库内 `packages/harness-bridge/spikes/stagehand-sdk` 整个目录复制到临时目录，在副本下执行 `npm ci --ignore-scripts --no-audit --no-fund`，再设置 `STAGEHAND_PROBE_CHROME` 为已审核的 Chrome for Testing 可执行路径，运行 `npm test`。需要允许启动本机 Chromium 和监听回环端口；测试不下载浏览器，也不读取模型凭据。

真实浏览器、实际 SDK/扩展和已补丁的官方 Worker 都参与验证。模型结果是明确标注的固定夹具，证明回调/用量/限制传递，不代表真实 provider 的推理效果、价格、计费精度或生产资格。

专项最终验证 11/11 通过，零失败、跳过或取消（`probe.tap`）；涵盖 SDK 文件摘要、v4 配置、版本漂移拒绝、无主调用、超大输入、缺失用量、无效回包、输出超限，以及真实 Worker/扩展的观察、点击、双请求提取、准入拒绝、逐调用限额、部分失败和取消排空。

首次仓库检查将文档目录验证脚本中的上游导入字面量识别为越界；已将可执行验证和补丁整体归属 `harness-bridge/spikes/stagehand-sdk`，原边界规则未修改，复查通过（`check-boundary-initial.log`、`boundaries.log`）。最终能力回归 18 组、345/345 通过；完整 `npm run check` 执行全部 74 个集成文件，408 通过、1 失败，零跳过/取消。唯一失败是指定 Windows 10/i7-7700 设备验收在本机 macOS/i7-9750H 上触发机器身份断言，完整检查因此退出 1（`check.log`、`validation.json`）。

首次能力采集遇到现有 1000 工具图布局 100.1ms 超过 100ms 门限，单独 27/27 复验及最终完整能力回归均通过；保留 `capability-timing-attempt.log` 和 `execution-graph-recheck.tap`，未修改性能门限。期间完整检查曾因旧证据摘要停止，重采集后校验通过。测试生成目录已归档并恢复本轮开始时内容（`generated-archive.json`），保留新的能力证据报告。
