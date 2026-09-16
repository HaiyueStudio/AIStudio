# Basic 材质透明配置

BasicMaterial 的颜色 alpha 与渲染混合模式是两个独立参数。Engine 默认 `blending: none`，不透明着色路径将输出 alpha 强制设为 1。旧 Studio 只传颜色，所以 `[0,0,0,0.01]` 仍然渲染为黑色。

Studio 在 `render/basic-transparency.ts` 统一创建 Basic 材质，编辑场景和独立 Play 使用相同规则：

| 配置 | 混合 | 默认深度写入 |
| --- | --- | --- |
| 省略 blending 或 auto，alpha = 1 | none | true |
| 省略 blending 或 auto，alpha < 1 | normal | false |
| none | 强制不透明 | true |
| normal | 普通 alpha 混合 | false |
| additive | 叠加 | false |

`depthWrite` 支持 `auto`、`true`、`false`，显式布尔值优先。深度测试继续开启。旧文档不需要迁移：省略可选字段即自动模式；只有修改颜色时保留之前的显式策略，设置两个字段为 `auto` 可恢复默认。

Agent 可通过 `material.set` 或 `component.configure` 配置 `haiyue.render.material`，属性面板也展示混合与深度写入选项。示例组件值：

```json
{
  "material": "basic",
  "color": [0, 0, 0, 0.01],
  "blending": "auto",
  "depthWrite": "auto"
}
```

运行时修改颜色会重新计算自动模式。共享材质隔离时复制其创作策略，不能把当前解析出的 GPU 混合模式误认为用户显式设置。原生、非 Studio 创建的 Basic 材质保留其自身设置。PBR 继续使用独立的 `haiyue.material.pbr.alphaMode`，不受 Basic 策略影响。透明度也不改变射线拾取行为。

验证包括场景保存重开、撤销重做、Agent 单工具与事务、IPC 参数、属性面板可选字段、运行时 alpha 切换与共享材质隔离。Electron 使用独立临时数据目录进行实际 WebGPU 渲染，对比编辑和隔离 Play 的中心像素（黑色立方体、白色背景）：

| 输入 | 编辑 RGB | Play RGB |
| --- | --- | --- |
| alpha 0.01 / auto | 252,252,252 | 252,252,252 |
| alpha 0 / auto | 255,255,255 | 255,255,255 |
| alpha 1 / auto | 0,0,0 | 0,0,0 |
| alpha 0.01 / none | 0,0,0 | 0,0,0 |
| alpha 0.5 / normal | 128,128,128 | 128,128,128 |

测试入口：`apps/ai-studio/test/basic-transparency-electron.test.mjs`。这些用例验证基本透明合成，不代表所有相交透明网格的排序效果。
