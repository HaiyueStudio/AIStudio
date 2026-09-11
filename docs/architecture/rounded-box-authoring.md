# 圆角立方体创作与检索查询预算

AIStudio 通过当前 Engine 候选包公开的 `@haiyue/engine/experimental` 导出消费
`createRoundedBox3D`。该候选的 `geometry` 运行文件虽导出此函数，类型入口尚未导出；
使用已声明的公开 experimental 入口，无需修改或升级 Engine 包。

`entity.create` / `entity.create-many` 的 `kind: "rounded-box"`、资源面板模板及
`haiyue.render.geometry` 组件使用同一参数校验和 Document History。

| 参数 | 坐标与范围 | 默认值 |
| --- | --- | --- |
| radius | 本地坐标中的圆角半径，0–0.5；0 表示无圆角 | 0.075 |
| segments | 每条圆角带的细分数，整数 1–16，限制网格生成成本 | 4 |

原始几何以原点为中心，各轴范围 [-0.5, 0.5]。Transform 在几何圆角生成之后生效，
等比缩放保持圆弧半径形状；非等比缩放会拉伸圆角。PBR 材质需场景光照。

例如，以当前 `baseRevision` 调用 `entity.create`：

```json
{"baseRevision":1,"kind":"rounded-box","radius":0.1,"segments":4,"material":"pbr","name":"Cubie"}
```

已有普通方块可通过 `component.configure` 修改，先查询当前实体及修订：

```json
{"baseRevision":2,"action":"upsert","entityId":"entity:example","type":"haiyue.render.geometry","patch":{"kind":"rounded-box","radius":0.1,"segments":4}}
```

创建、批量创建、撤销/重做、保存/重开及编辑/Play 都保留参数，渲染共用圆角工厂。
旧的 `cube` 保持普通立方体；明确要求圆角时不得以普通立方体替代。

知识检索上限仍为 2048 UTF-8 字节。上下文组装器对超长请求提取预算内的首尾片段，
同时涵盖前部任务要求与尾部修复要求；按 Unicode 码点取样，不截断中文或 emoji。
完整脱敏任务文本仍按原有 32768 字节上下文预算进入模型，不因检索预算被截短。
空白请求不发起检索；权限、来源、版本及修订过滤继续生效，其他检索错误不会被吞掉。
`knowledge/query-bounded` 仅记录策略和字节数，不重复记录完整任务文本。
