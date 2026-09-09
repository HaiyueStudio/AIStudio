# Canvas 纹理与平面方向

`asset.generate-texture@1.0.0` 用 Canvas 2D 将结构化绘图指令导出为 PNG，并在当前项目登记素材。它通过原工具目录、审批、版本检查和 Document History 执行；应用只提供隔离 Canvas 窗口，PNG 的写入和登记由项目服务负责。

先保存项目，通过 `project.snapshot` 获取当前 `baseRevision`。下例中的版本号仅作示例，执行时必须使用实际版本：

```json
{
  "baseRevision": 1,
  "recipe": {
    "schemaVersion": 1,
    "width": 256,
    "height": 256,
    "commands": [
      { "type": "circle", "x": 128, "y": 128, "radius": 118, "fill": "#f0d6a4", "stroke": "#b00000", "lineWidth": 5 },
      { "type": "text", "x": 128, "y": 128, "text": "将", "fontSize": 160, "fontFamily": "serif", "fill": "#b00000" }
    ]
  }
}
```

坐标以像素为单位，原点在左上，X 向右、Y 向下。支持 `rect`、`circle`、`line`（折线）、`polygon`、`text`；文字默认水平居中、垂直居中，字体使用系统通用字体族。颜色为 `#RRGGBB` 或 `#RRGGBBAA`；未指定背景时透明。宽高各为 1–2048，最多 512 条指令、每条路径最多 128 个点，整体绘图数据最多 128 KiB，同时受既有工具参数结构预算约束。不接受脚本、外部图片和外部字体。

结果包含 `asset.id`、宽高、摘要和 `assets/generated/<内容摘要>.png` 相对路径。使用新的项目版本调用 `asset.assign`，将该 ID 作为 `texture.base-color` 绑定到几何实体；现有 PBR 材质仍需场景灯光或环境光，透明图片需相应材质透明模式。可以通过原有组件工具调整材质。相同内容不会覆盖已有文件。Undo 撤销登记，保留 PNG 字节供 Redo；命令提交前失败会清理本次新文件，取消或项目切换后的迟到结果不能提交。

`entity.create` 和 `entity.create-many` 中的平面实体支持可选 `plane` 参数：

| 值 | 局部几何平面 | 正面法线 | 用途 |
| --- | --- | --- | --- |
| `xy`（默认） | XY | +Z | 保持旧几何语义，常用于竖直面 |
| `xz` | XZ | +Y | 水平棋盘、地面 |
| `yz` | YZ | +X | 侧面 |

例如创建水平面可传 `kind: "plane", plane: "xz"`，保持零旋转，通过 X/Z 缩放控制尺寸。方向持久化在 `haiyue.render.geometry`，几何确定方向后才应用 Transform；不要再叠加原先为 XY 平面补偿的 X 轴 -90° 旋转。

修改现有面前先读取几何组件和 Transform。使用 `component.configure` 的 `upsert` 为 `haiyue.render.geometry` 设置 `patch: { "plane": "xz" }`，必要时再通过 `transform.set` 移除原先的补偿旋转，保留真正需要的倾斜。每次修改均提交最新版本。编辑视图和游戏预览共享同一平面工厂，未指定方向的旧组件统一按 XY 解释。

该能力没有内置象棋规则或专用生成提示词；示例仅展示通用文字纹理。现有游戏项目需要由用户或已批准的 Agent 操作实际生成和分配素材。
