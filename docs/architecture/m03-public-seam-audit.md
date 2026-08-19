# M03 public seam audit

最终审计日期：2026-08-19。M03 milestone 与所有非 cancelled Goal 均为 `complete`，`D:\HaiyueStudio\Editor`
工作树清洁。AIStudio 从该 revision 生成并 vendored 四个 `npm pack` candidates，未使用跨仓源码路径。

## Accepted public packages

| Package | Accepted seam | AIStudio use |
| --- | --- | --- |
| `@haiyue/editor-plugin-sdk@0.1.0` | lifecycle scope、service/contribution port、Document/History/Selection、generic `EditorProductAdapter` | Stable adapter/input types |
| `@haiyue/editor-platform@0.1.0` | `DocumentHost`、`HistoryService`、`SelectionService`、`TaskCoordinator`、`./conformance` | Scoped providers mounted under the Cordis root |
| `@haiyue/editor-shell@0.1.0` | browser contribution hosts、shortcut routing、lazy plugin loader | Optional shell primitives; Studio panels remain AIStudio-owned |
| `@haiyue/editor-app-kit@0.1.0` | app descriptor、path/budget validation、Node assembler | Desktop artifact assembly candidate |

Tarball SHA-256、npm integrity、public exports 和 lock provenance 由 `config/upstream/editor-candidates.json` 与
`npm run editor:candidate:check -- --milestone-file <M03 milestone.json>` 固定。当前门禁通过。

## Scene ownership clarification

M03 的 `editor/` 是私有 Scene Editor 产品，而不是供其他产品复用的 Scene implementation package。M06 构建新的
AIStudio 产品，因此不复制或深导入该产品的 `EditorStore`、`World`、DOM 或 engine adapter。

AIStudio 在 G04/G05 实现自己的 Scene product adapter：

- 复用 M03 的 generic Document/History/Selection/Task contracts；
- 只通过版本化 Engine public exports 创建和渲染自己的 Scene；
- 对 Studio 插件与 Agent 暴露 `config/contracts/editor-scene-adapter.d.ts` 定义的 immutable snapshot、revision-checked
  prepare/commit/rollback、diagnostic 和 stable picking port；
- 将 M03 service primitives 作为 scoped providers 挂入唯一 Cordis root，不实例化第二个 `EditorPluginHost`。

这个边界符合 M03 “不统一产品领域模型”的契约，也使新编辑器不依赖旧 Scene Editor 私有实现。

## Gate result

`GO`：M03 状态、四个 packed public candidates、exports、integrity、AI-neutral boundary 和 typecheck 均已验证。G01 可在
完整总门禁通过后完成，G02 可按依赖顺序开始。
