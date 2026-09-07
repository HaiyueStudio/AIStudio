# M14 G01：能力面与首版冻结范围

2026-09-06。用户授权 G01 提前实施和独立验收；此例外不改变 M13 G11、M12 G12 的状态，也不解除 G02 及后续 Goal 的前置门禁。

2026-09-07：本文及当前机器清单已同步执行顺序编号。原 G03 合同现为 G02，原 G02 布局现为 G03；其他对应关系见 [编号对照](../../../milestones/milestones/m14-ai-native-intent-graph-editor/goal-renumbering-2026-09-07.json)。已验收文档的历史原文另保留编号说明。

## 唯一事实源与产物

| 产物 | 用途 |
| --- | --- |
| [当前矩阵](../../config/contracts/m14-capability-census.json) | 自动派生的六层记录、组件/工具摘要、实际安装包 exports 和完整输入摘要 |
| [验证记录](../../config/contracts/m14-capability-verification.json) | 本次构建、测试入口、开始时间、时长、通过/失败/跳过数、输出摘要与输入绑定 |
| [首版范围](../../config/contracts/m14-capability-first-release.json) | 既有能力清单、G08 数量预算、三类来源验证集合和 G05/G09 交接 |
| [关联说明](../../config/contracts/m14-capability-sources.json) | 经审查的能力→源码/测试/工具关联；无执行 handler、组件默认值或新能力 ID |
| [类型](../../packages/studio-contracts/src/m14-capability.ts) / [Schema](../../config/contracts/schemas/m14-capability-surface-record-v1.schema.json) | G01 唯一冻结的 CapabilitySurfaceRecordV1，复用 M12CapabilityId |

ComponentRegistry 和 GAME_AUTHORING_TOOL_DEFINITIONS 仍是唯一运行时注册来源。采集器先构建，再从已安装 workspace 的公共 exports 读取实际描述，并用 TypeScript AST 核对当前源码中的组件 ID、capability、adapter 和工具 ID。矩阵只输出版本、描述摘要、所有者、效应/风险、预算等投影，不复制完整 schema/defaults，也不供产品代码注册能力。

工具的 requiredCapabilities 同时包含服务 token 和 M12 capability ID。仅精确匹配已有 M12 union 的项自动关联；通用组件工具及跨领域工具的关联显式记录在 sources 文件。`studio.tool.invoke` 是调用传输入口，单独记录，不计入业务工具数量。不能用同名前缀把服务 token 扩展成能力 ID。

## 六层证据的含义

每层固定包含 owner、current/stale/missing、引用的路径/内容摘要/类型/定位与限制说明。

| 层 | G01 核对范围 | 不自动推导的结论 |
| --- | --- | --- |
| upstream | 安装包版本、lock integrity、reviewed tarball 摘要、真实 exports 和目标文件内容 | 某个 export 存在不等于 AIStudio 接入其全部 API |
| document | GameDocument、持久化/迁移源码、注册组件的 serialization 描述和现有 round-trip 测试 | schema 可序列化不等于已完成所有迁移验收 |
| runtime | 已有 Play、物理、渲染效果、声明式运行时及相应源码位置 | adapter 名称不等于设备上已运行通过 |
| tool | 同一现有工具目录、发现/调用入口和测试 | 注册数量不等于所有 UI 或 Backend 路径已通过 |
| ui | 当前 renderer/shell 的可检查接入位置 | 源码存在不等于新行为/资源面板已完成 |
| verification | 与本次完整输入绑定的本地回归；保留单独标注的历史引用 | 本地回归不等于正式 adapter/product acceptance |

`current` 表示该证据对当前输入有效，其证明范围仍由 kind 和说明限定。历史 M12 census 始终为 historical，即使今天重新计算它的文件摘要，也不能成为当前验证。没有本次回归的 Agent 能力保留 stale verification；未纳入本次检查的 provider exports、设置持久化和工具层保留 missing，不填“默认通过”。本合同暂不支持不适用项豁免，避免静默跳过六层条件。

本次所有能力的 stage 保守保留 `implementation-present`。已执行的本地测试独立记为 current/local-check。`adapter-ready` 必须有针对能力的明确 adapter acceptance；`product-integrated` 还必须有当前六层证据及正式 product acceptance。Schema 限制结构和必填条件，语义检查拒绝把 local-check 冒充验收。G08/G09 后续增补实际验收读取器时，由串行集成 owner 同步类型、schema、来源与验证，不允许手改生成矩阵提升状态。

## 当前公共 Editor 接入点

安装候选已提供 EditorDocumentHost、History、Selection、TaskCoordinator、Contribution/Service Registry、生命周期与 PluginHost；Shell 提供 BrowserEditorShell、lazy plugin loader、快捷键、历史控件等；SDK 的 contribution kind 已包含 panel、inspector、viewport 等。四个 Editor 候选的 exports/版本/lock integrity 与 M03 完成状态由既有 candidate checker 核验。

因此 G07 应先使用现有公共基础设施实现产品适配。不能因未发现一个名为 advanced-authoring 的 export 就声称“没有公共面板接入点”；同样，基础设施存在也不证明 AIStudio 已有完整的高级几何、动画或资源编辑面板。具体新公共接口需经后续候选包评审。

## 首版范围与交接

G08 冻结为零项新增适配阻断项，最多两项的上限仍生效。依据是已有脚本、声明式规则、计时器、状态、HUD、物理/动画 adapter 可作为首个行为读模型的来源；当前可确认的新增工作主要属于 G02/G05 的结构与来源绑定、G06 的目录身份和 G07 的手动编辑入口。零项不是对全部适配器的完成声明。若后续发现运行阻断，必须先由串行 owner 更新冻结清单，补齐精确 capability/adapter、既有源码、owner、实例/运行预算和验证入口。

G05 验证集合明确区分：

- 纯脚本：现有多脚本稳定顺序/故障隔离窗口测试作为基础，增加结构、解释、trace 与源码定位断言。
- 纯声明式：现有 DeclarativePlayRuntime 单测没有脚本；G05 必须新增 Play plan 中脚本数为零的窗口用例，不能用混合用例代替。
- 混合：现有 g08-declarative-play 窗口 fixture 含 `api.scene.observe` 脚本。需增加组件/脚本/adapter 来源及仅组件改变时过期、跨项目/Play 隔离、碰撞/动画 unknown 边的断言。

数量、tick、seed、单次时限及 trace 配额以 first-release.json 为准。G01 冻结验证范围和预算，不定义 BehaviorManifest/Explanation/Trace 或资源 kind 的新合同；这些仍归 G02。真实设备身份与设备结果由 G05/G09 在各次运行记录；本地测试耗时不能冒充设备性能。

参数化几何、完整 GUI、专用格式、导航、游戏存档、RTT/Compute 六批仍在首版范围外；安装包的 export 清单可用于后续定位，不能直接准入。

## 复现与失效

在 AIStudio 根目录运行：

```text
npm run m14:capability:capture
npm run m14:capability:check
npm run check
```

capture 重新构建当前 workspace，顺序执行 sources 中固定的测试组；任何失败、跳过、取消或零测试都不会形成有效新验收。验证记录只保存结构化汇总和输出摘要，不保存原始模型响应、秘密或隐藏推理。矩阵与验证记录分别写入；中途失败产生的不匹配组合会被 check 拒绝，必须重新采集。

check 只读地核对包、注册表、关联、schema、首版预算和完整矩阵；它已经加入仓库 `npm run check`。输入绑定包含 packages/apps 源文件和测试辅助文件、配置/schema/fixture、构建脚本、package/lockfile、vendor，以及八个上游实际安装包的全部发行内容（包括 dist 内部被转导出的文件）；不包含生成矩阵/报告自身、workspace 的临时 dist、其他 node_modules 缓存或历史 evidence 文件夹。改变已绑定输入后必须显式 capture，不会仅凭新时间戳刷新旧证据。

后续叶 Goal 改变输入时，由串行集成 owner 刷新这两个 current 产物并重跑门禁；不通过修改旧报告的 inputDigest 消除 stale，不改动已验收 Goal 的历史完成说明和 M12/M13 baseline。

采集用于当前工作区的精确字节版本，包含尚未提交的前序修复；不宣称对应某个已发布提交。M12/M13 历史测量、完成记录和 release baseline 均保持各自原有所有权。
