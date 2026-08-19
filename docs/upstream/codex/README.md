# Codex App Server upstream pin

- npm package: `@openai/codex@0.148.0`（Apache-2.0）
- transport: local child process, stdio JSON-RPC
- auth: App Server managed ChatGPT sign-in/subscription，或 Codex 官方支持的 API-key mode；AIStudio 不读取 credential 文件
- Studio tool seam: pinned `dynamicToolCall` adapter（experimental）

`app-server-schema-0.148.0/` 的 380 个 JSON Schema 文件和 `app-server-types-0.148.0/` 的 752 个 TypeScript 文件由固定
CLI 带 `--experimental` 生成。`config/upstream/pins.json` 保存两个目录的内容哈希，`compatibility.json` 固定 G07
必须支持的 initialize、account/auth、thread、turn、stream、dynamic tool、approval、cancel 与 rate-limit surface。

Dynamic tools 在该版本仍是实验接口，因此所有 wire types 仅存在于 `agent-backends` adapter，进入 Studio 前以 `unknown`
校验。schema 缺失或漂移时 fail closed；不得回退为解析自然语言，也不得打开 Codex built-in shell/network/package/file
能力。若后续固定版本移除该结构化 seam，再以 ADR 评估 localhost MCP。

认证与 App Server 行为参考 OpenAI 官方文档：

- <https://learn.chatgpt.com/docs/auth>
- <https://learn.chatgpt.com/docs/app-server>
