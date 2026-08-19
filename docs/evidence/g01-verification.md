# G01 verification snapshot

日期：2026-08-19。工作树：AIStudio initial repository skeleton（尚未创建 commit）。Runner：Windows，Node `v24.19.0`；
仓库 `.node-version` 与最小 engine 固定为 `22.19.0`，DeepSeek Harness 声明同时支持 `^22.19.0 || >=24`。

## Passed

- `npm install`：生成 lockfile，固定 DSH/Cordis、Codex CLI 和验证依赖。
- `npm run codex:schema:generate`：从 `@openai/codex@0.148.0` 可复现生成 380 JSON Schema + 752 TypeScript files。
- `npm run check`：16 schemas、15 valid fixtures、8 rejection fixtures；TypeScript、boundary、upstream hash、双 fake backend
  tool/cancel/teardown spike 全部通过。
- `npm audit --json`：0 个已知 vulnerability。初始 AJV 8.17.1 的中危 `$data` ReDoS 已通过固定 8.20.0 消除；
  AIStudio validator 不启用 `$data`。
- DSH tag 完整 commit 为 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`；license 与 third-party snapshot hash 通过。
- 对当前 Editor candidate 做只读检查：四个 foundation workspace 与 Scene Editor typecheck 通过，platform API 和
  repository/AI-neutral boundary gate 通过；没有运行会生成 `dist` 的 build/test，也没有改写该脏工作树。

## M03 gate

- M03 milestone 与全部非 cancelled Goal 均为 `complete`，Editor 工作树清洁。
- 从完成 revision 生成 `editor-plugin-sdk`、`editor-platform`、`editor-shell`、`editor-app-kit` 四个 packed candidates，
  tarball SHA-256、npm integrity、exports 和 lock provenance 均通过。
- `@haiyue/editor` 保持 private 是预期边界；AIStudio 在 G04/G05 使用 Engine public API 实现自己的 Scene product
  adapter，不复用或深导入旧 Scene Editor。
- `npm run editor:candidate:check -- --milestone-file D:\HaiyueStudio\milestones\milestones\m03-unified-editor-platform\milestone.json`
  已通过。详见 `docs/architecture/m03-public-seam-audit.md`。

本文件是开发验证记录，不替代 G10 同一 reviewed revision 的正式 POC evidence。
