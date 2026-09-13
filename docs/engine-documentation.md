# 本地引擎文档与按需检索

AIStudio 不把完整引擎手册放入初始上下文。规划时先发现能力，编码时再读取当前环境支持的 API、前置条件和示例；场景数据仍按影响范围读取。

## 使用顺序

1. `engine.docs.search({query: "棋盘 点击 命中"})` 返回短摘要、`id` 和 `bundleDigest`。默认仅查询 Studio 脚本和场景编辑入口。
2. `engine.docs.read({id, bundleDigest})` 返回完整声明/段落/示例及相关文档。沿 `nextCursor` 分页，保持 id 和 bundleDigest 不变。
3. 检查要求的组件、capability、坐标空间和单位，再用 `scene.query` 获取受影响对象，提出脚本修改。
4. 编译错误时检索错误涉及的符号。编译通过后仍需检查真实变换、输入和画面；脚本自报计数不证明实际运动。

需要了解尚未接入 Studio 的引擎能力时显式指定 `surface: "engine-native"`，或用 `"all"` 对比入口。查到原生类不等于可以在 onUpdate 中 import/new。`tool.search`、`component.describe` 继续提供当前注册表的精确信息。

搜索默认返回最多 6 条、4 KiB；读取默认 16 KiB、最多 32 KiB。预算不足以容纳完整声明时返回所需字节数，不截断代码。重复读取当前文档可由 Agent 复用已有内容；上下文压缩后仍可按 id 重新读取。实际 token 数取决于模型 tokenizer，工具预算按 UTF-8 JSON 字节计算。

## 文档所有权与构建

- Engine 原生签名：安装包的 `package.json#exports` 与公开 `.d.ts`，通过 TypeScript 解析 barrel exports，保留 public overloads，排除 private/protected members。
- Engine 指南：Engine 仓库运行 `npm run docs:export -- <output.json>` 导出伴随产物。AIStudio 审核后放入 `vendor/haiyue-engine-reference-docs.json`，在 `config/engine-docs-source.json` 锁定产物摘要及目标引擎 integrity。
- Studio 脚本：`studioScriptRuntimeDeclarations`，与实际校验器共用来源。Entity/Component/System/World 的可达实例成员另列为脚本参考，不开放构造器。
- 场景编辑：工具与组件注册表；组件默认值与 schema 自动生成。
- Studio 通用指南：`packages/game-authoring-tools/docs/guides.json`，同时用于原有自动检索和新文档工具。
- 可执行 Studio 示例：`docs/examples/grid-placement.ts`、`docs/examples/rotate-self.ts`，经过真实编译器和针对性执行验证。

`game-authoring-tools` 构建生成 `dist/engine-docs/{bundle,binding}.json`；Electron 构建复制到自己的 `dist/engine-docs`。完整文档不进入 renderer bundle，也不全量写入检索日志。主进程只读加载；每次模型读取的结果才保存为可重放的 artifact。

升级依赖后重新审核参考文档产物并构建，不能只修改 `engineVersion`。相同 semver 的候选包依靠 integrity 区分。运行 `npm run engine:docs:check` 检查产物是否与当前声明、脚本契约、组件和文档来源一致；该命令已接入总检查。

## 边界

文档可帮助选择和正确调用 API，但不能代替对象拆解和玩法验证。原生指南按来源修订保留，不声称所有原生示例都能在 Studio 执行。默认检索使用确定性的符号/关键词匹配及领域中英文词；当前没有额外下载 embedding 模型。未命中不等于功能不存在，应继续查能力/组件或明确指出接入缺口。
