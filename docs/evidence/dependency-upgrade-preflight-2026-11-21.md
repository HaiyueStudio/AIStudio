# 依赖升级实施预检

日期：2026-11-21。关联[升级方案](../architecture/dependency-and-model-upgrade-plan-2026-11-21.md)。

后续状态：用户已提供 `D:/HaiyueStudio/milestones`，M06 contracts、integration、双后端 Goal 与 M13 活动 Goal 已补读，原先的前置阻塞已解除。Codex/GPT 6.2、Engine、UI/Editor 和 Harness 已按顺序实施；最终结果见[升级验证记录](dependency-upgrade-result-2026-11-21.md)。下文保留首次预检时的安装、失败和前置条件记录，属于历史状态。milestone 状态未推进。

## 已完成

- `npm ci --allow-remote=all --cache .npm-cache --no-audit --no-fund` 完成，安装 183 个包。`allow-remote=all` 只作用于本次命令，用于 npm 12 接受既有锁文件中带 integrity 的远程 tarball；未写入全局 npm 配置。
- 补齐 Electron 43.5.1 二进制与 esbuild 安装准备；node-pty、koffi 原生模块可加载。宿主 Node 为 24.21.0，Electron 内嵌 Node 为 24.19.0，均满足计划中的 Harness 运行时最低要求。
- 现有应用完整构建成功。
- `npm test -w @haiyue/ai-studio-agent-backends`：22/22 通过。
- runtime 的 accounting、backend-session、request-context 三组定向测试：28/28 通过。
- `npm run contracts:check`：57 个 schema、58 个合法与 97 个非法 fixture 验证通过。
- `npm run boundaries:check`：3/3 定向测试及依赖边界扫描通过。
- 真实 Windows 图形环境下 `electron-smoke.test.mjs`：1/1 通过，涵盖 sandbox/preload、renderer、WebGPU、脚本/Agent UI、像素候选、reload 和关闭。
- 隔离安装精确 `@openai/codex@0.171.0`，成功生成 483 个 JSON Schema 文件与 968 个 TypeScript 文件。尚未替换仓库中的 0.148.0 生成物。
- 使用隔离的新 Codex 二进制与现有 backend adapter 进行只读 App Server 预检：ChatGPT 登录 ready；目录含 `gpt-6.2-sol` 和 `gpt-6.2-astra`。这证明新二进制可启动且当前账号能发现目标模型，不代表产品已切换或真实生成/工具调用已验收。未手工读取凭据文件，未发送模型生成请求。可选 rate-limit 查询暂时不可用，未影响已验证的登录状态。
- `.gitignore` 加入 `.npm-cache/`，避免本次安装缓存进入变更集。

## 尚未通过的总检查

第一次 `npm run check` 已通过契约、类型、边界、上游 pin、Engine/扩展候选和协议 spike 阶段，随后 quick eval 因缺失 Electron 二进制及尚未构建应用而失败。

补齐构建和 Electron 后，quick eval 为 58/59；剩余 dry-run 在受限身份下先遇到相邻 Engine 仓库 Git ownership 检查。在正常宿主环境中运行同一 dry-run，进一步确认失败原因是 **`D:/HaiyueStudio/milestones` 不存在**。没有通过伪造 milestone、跳过 revision 检查或放宽验收条件把它改成成功。

受限环境下的 Electron 初次尝试因 GPU 子进程无法启动而失败；使用同一测试和同一构建，在正常 Windows 图形环境重新执行后通过。该重跑不改变应用安全配置或使用 mock GPU。

## 下一步前置条件

仓库 [AGENTS.md](../../AGENTS.md) 明确要求：

> Before changing a package, read its nested `AGENTS.md`, M06 `contracts.md`, `integration.md`, and the active Goal.

已阅读相关 nested AGENTS、现行 contract-index、M12/M13 contracts 与双后端/生命周期架构文档。工作区和 Git 文件历史中均未找到上述 M06 原始文件；相邻 `milestones` 仓库缺失，连接的 GitHub 查询也未取得该仓库。

需要提供可访问的 milestones 路径，或明确允许本次以现有 `config/contracts`、架构文档和已确认升级方案作为实现约束继续。取得该输入后，从正式 Codex/GPT 6.2 切换及其回归开始；其后的 Engine、UI/Editor、Harness 任务保持待完成。

UI 阶段另需兼容 UI 0.2.x 且保留 advanced-authoring 的受审 Editor Shell 候选；当前 0.1.1 候选仍限制 UI `<0.2.0`。
