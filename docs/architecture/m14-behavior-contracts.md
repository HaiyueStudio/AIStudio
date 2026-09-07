# M14 G02 行为与资源读模型

本页记录私有 workspace 合同与调用边界。类型唯一位于 [m14.ts](../../packages/studio-contracts/src/m14.ts)，schema、owner 和消费者由 [合同索引](../../config/contracts/m14-contract-index.json) 指向。设计依据是 [ADR 0084](../../../milestones/docs/for-ai/adr/0084-behavior-projections-and-resource-identities.md)。G03/G04 可消费这些导出；窗口接线、运行采集和项目归档仍由 G05/G06 完成。

## 三个独立投影

- `BehaviorManifestV1` 记录结构、来源、未知原因、截断和来源绑定。结构边表示来源中可识别的控制流或配置关系，不表示该路径已经运行。
- `BehaviorExplanationV1` 绑定 manifest digest 和节点，独立保存语言、producer、依据和自身摘要。`verified-structure` 是结构模板解释；`agent-claim` 始终是声明，不能充当运行证据。当前读服务提供 `en` / `zh-CN` 模板，不调用模型。
- `BehaviorTraceV1` 记录某次 Play 的事件、节点进入/退出、tick/frame、微秒时长、状态差异、错误和取消。`associateBehaviorTrace` 校验既有 `ObservationArtifactV2` 的摘要、字节数、Play、修订和脚本选择；不会新增观察结果 envelope。

观察摘要计算为 SHA-256(canonical JSON(trace))，包含 trace 自身的 digest；trace 自身摘要排除自身 digest 字段，避免循环。当前 manifest、source binding、Play ID 和 generation 都匹配时才能叠加。旧绑定只返回 `historical`。Play 可显式选择启用脚本的子集；每条观测中的脚本必须包含在该次 observation 的选择中。

## 来源与摘要

输入复用 `GameDocumentV2` 和 `ComponentDefinitionV2`。先检查未知版本、数据形状、字节预算和敏感数据，再复用 `ComponentRegistry` 与 `GameDocumentStore` 验证组件和文档关系；不调用 `apply`，不创建 History 事务。

canonical JSON 采用 UTF-16 字典序排列对象键，数组保留语义顺序，UTF-8 编码后计算 SHA-256。作为集合的 scenes/entities/components/scripts/assets 按 id 排序，registry 按 type/version 排序，adapter 按 id 排序。实体顺序字段、组件归属数组、规则及 action 顺序保留。重复 ID 被拒绝。

binding 包括项目/文档身份和修订、文档结构摘要、所有脚本的原始文本摘要与启用状态、组件值/启用状态摘要、资源与 settings 依赖摘要、完整 registry 描述及 adapter 版本/摘要。脚本文本先与已有 digest 核对，派生结果不保存正文。savedRevision 和 migration 时间不属于结构输入。

manifest 摘要覆盖 binding、分析器版本、配置摘要和整个有界结构。解释语言、Play 路径、采集时间和随机数不进入分析输入。改变分析实现或所用 TypeScript 语义时必须升级 `BEHAVIOR_ANALYZER_VERSION`，不能复用旧版本的结构缓存。

脚本范围直接映射原始已提交 TypeScript，不经代码围栏清洗、补行或转译。offset 是 UTF-16，end 不包含终点；行列从 1 开始。声明式来源使用组件 id/type/version 和 JSON Pointer；adapter 来源使用绑定的注册 id/version/digest。当前范围核对原始文本；旧范围不会被当作当前行号。

## 分析边界

[脚本分析](../../packages/script-preview/src/behavior/script.ts) 分离函数入口、串行、分支、循环、await、try/catch/finally 和 abrupt completion。`Promise.all` 保留实参求值的串行顺序，另用 fork/join 描述聚合 settlement 关系；它不证明实际执行重叠或成功。检测到 Promise 名称遮蔽、别名或修改时保留 dynamic unknown。属性访问、无法解析的调用、迭代器协议、switch fall-through、类初始化等保留精确源入口和未知原因，不承诺任意 TypeScript 无损还原。

[声明式分析](../../packages/script-preview/src/behavior/declarative.ts) 仅解释与当前内置注册描述一致的规则/计时器字段，保留 action 顺序和跨实体 targetObservationId。未知、缺失或歧义目标不生成确定的驱动边。物理/动画仅确定组件与已注册 adapter 的关联；碰撞发生条件和 adapter 内部推进保留 unknown。禁用组件和脚本不产生执行结构，其变化仍使绑定失效。

## 私有读服务

`@haiyue/ai-studio-script-preview` 导出 `BehaviorReadService`、`analyzeBehavior`、`createBehaviorSourceBinding`、`parseBehaviorContract`、`createBehaviorTrace`、`associateBehaviorTrace` 和 `projectBehaviorResources`。`@haiyue/ai-studio-agent-orchestration` 导出仅依赖合同的 `BehaviorReadPort`。renderer 只消费数据/类型；Node 分析实现由现有 composition root 注入。

```ts
const manifest = await service.analyze(input, abortSignal);
const binding = {
  schemaVersion: 1,
  manifestDigest: manifest.digest,
  sourceBindingDigest: manifest.binding.digest,
};
const page = service.query({ ...binding, entityId, offset: 0, limit: 50 });
const location = service.locate({ ...binding, nodeId });
const explanation = service.explain({ ...binding, nodeIds: [nodeId], language: 'zh-CN' });
const position = service.resolveLocation(location);
```

query 的可选过滤为 entityId/kind，offset 非负，limit 1–100；返回页内节点间的边。locate/explain 必须带精确 manifest/source binding。不存在或过期的绑定报 `behavior.stale`。解释一次最多 100 个唯一节点。服务每次 analyze 立即使旧投影失效；替换请求先终止并回收前一 worker。项目变化调用 invalidate，根生命周期调用并等待 dispose。失败/取消不发布结果，重复 dispose 安全。

`resolveLocation` 校验 entity/component/script/resource/behavior-node 的当前依据。未接入资源持久化或 artifact authority 的模板、预设和 evidence 定位保留历史状态，G05/G06 注入对应权威之后才扩展当前定位。同步 `analyzeBehavior` 适用于受控无窗口任务；交互入口使用 worker 服务。

运行时只读取固定、随仓交付的 `config/contracts/schemas/` 文件，输入不能选择路径。封装应用时须连同这些 schema 部署；私有包不独立发布。

## 四类资源

`ResourceCatalogEntryV1` 的 kind 决定引用和合法动作。asset 引用已有受控 manifest 的 id/digest/source，许可、格式、解码预算和分配仍由 `ControlledAssetCatalog` 检查。模板引用 registry/defaults；预设引用持久化 ID/schema/value digest；实例引用项目/实体/修订和可选组件。

`unknown` 依赖/usage 与 `known: []` 不同。只有 asset 有 yes/no/unknown 的 unused，且必须与完整 usage 相符；其他 kind 的 unused 固定 `inapplicable`。灯光 template/preset/instance 不接受 asset.assign/import。unavailable 条目不能带可执行 intents；unsupported 来源必须 unavailable。artifactId 可为 null。

当前资源投影复用已有文件 manifest 和文档实例，并将尚未接入创建流程的 registry 模板标为 unavailable。没有持久化来源时不生成可用 preset，不把内存对象当项目记录。G06 负责后续工作流与完整依赖/usage 查询。

## 数值预算与验证

执行基线为 G01 的 Windows / Node >= 22.19 环境。输入 JSON 最大 8 MiB、200 scripts、10000 entities；每脚本沿用 M12 的 65536 字符限制。默认 AST 最多 100000 节点、深度 128，结构最多 2000 节点/4000 边/2 MiB；config 只能收紧上限。结构预算耗尽保留截断原因及 omittedAtLeast 下界，不伪造未访问总量。

解释最大 256 KiB；trace 最大 10000 事件/4 MiB；单资源条目最大 256 KiB，目录投影最多 12000 条；位置最大 4096 字节。JSON 深度最多 128，拒绝 getter、cycle、symbol、非有限数、二进制及 live object，敏感键和常见凭据格式被拒绝。trace 丢弃的尾部行也必须经过校验。worker 堆上限 192 MiB，单次超时 15 秒；所有长期资源归现有 root scope。

复现入口为 `npm run m14:behavior:check`；已有导出构建完成时可运行 `npm run m14:behavior:test`。验证含 [四来源 corpus](../../config/contracts/fixtures/m14-behavior-inputs.json)、[合同 fixtures](../../config/contracts/fixtures/m14-behavior-contract-cases.json)、[包内测试](../../packages/script-preview/test/behavior-analysis.test.mjs) 和 [公共消费者/既有 adapter 验证](../../apps/ai-studio/test/m14-behavior-contract.test.mjs)。合同校验函数验证数据与关联，不把任意导入者的自签摘要当作可信运行证据；真实 producer、项目归档及 UI 权限仍由原观察/日志链路负责。
