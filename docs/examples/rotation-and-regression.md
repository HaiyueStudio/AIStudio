# 组合对象拖拽、变换与回归

适用于分层旋转、门轴、机械臂、旋钮、组合零件和拖放对象。物体“动了”、脚本自报的角度/数量、截图存在，都不能证明行为正确。

## 装饰网格的射线穿透

已有 `haiyue.interaction.pointer` 支持 `penetrable`。通过 component.configure 给装饰网格配置**启用的**组件：

```json
{"events":[],"draggable":false,"capturePointer":false,"penetrable":true,"maxEventsPerTick":32}
```

这个配置直接使用 Engine Interactive.penetrable。mesh 仍渲染，但是指针 raycast 跳过它，继续命中后面的 mesh；不需要脚本。它不改变物理碰撞。不要禁用此组件：禁用意味着没有穿透配置，mesh 又会遮挡射线。真正接收交互的本体配置 penetrable:false，订阅 down/move/up/cancel 并捕获指针。子 mesh 的事件不会自动冒泡给父对象。

重复装配时，把装饰面片的穿透配置放入原型再实例化；不需要每个色块绑定脚本。魔方的颜色面是外观组成，运动根才是旋转成员。

## 职责与脚本资源

制定计划时列出：职责、脚本所属实体、输入来源、允许写入的对象，以及验收用例。

- CameraController：相机实体上的脚本，只调用 `api.scene.orbitControls({mode:"background"})`。
- ObjectManipulator：对象或组控制器上的脚本，处理命中、锁定成员、拖拽与吸附动画。局部对象用 selfInteractions；组控制器显式过滤 interactions 的实体 ID。
- 独立计时/胜负规则或 UI 在独立控制器上维护。紧密耦合的拖拽状态与动画可放同一脚本，不要机械地按函数拆分，也不要每个装饰面片一个脚本。

当前每个实体的 script.propose 编辑其脚本资源。需要独立控制器时先创建非渲染实体，再为该实体提案；不要覆盖已有相机脚本来添加对象逻辑。静态 transform、材质、pointer 配置留在 Document。

验证器会阻止在同一脚本中混合 orbitControls、对象交互读取和对象变换/改色。它是明确 API 调用的检查，不声称能理解所有业务逻辑；计划和代码审查仍需检查其他独立职责。

## 使用引擎变换，不累加欧拉角

`api.scene.transforms` 提供：

- worldPoint / localPoint：对象局部与世界坐标转换。
- projectPoint：世界点到当前相机的画布归一化坐标。
- dragAxis：根据当前相机、命中点与允许的世界轴选择投影方向最接近拖拽的轴。
- dragAngle：同一锁定轴上，把从按下开始的总拖拽位移换算成有符号弧度。
- capture / rotate：保存成员的真实世界矩阵，再按世界轴和枢轴施加绝对旋转，同时正确处理位置、朝向和父空间。

所有点/轴为世界坐标，输入位移为画布归一化值（左上原点，Y 向下），角度为弧度。不要混用截图像素和世界坐标；不要固定把 dx 映射到 Y 轴。

流程：按下保存命中点和初始输入；越过阈值后用 dragAxis 锁定允许的轴，根据按下的对象/逻辑格选定成员，再 capture 一次。后续 move 用 dragAngle 算总角度，对同一快照 rotate。松手时用同一轴/符号插值到目标角度；取消则 rotate(...,0)。下一次操作重新 capture。成员列表不能同时包含父运动根与其子网格。不要每帧重捕获，也不要对 rotation[x] 做 +=。

```ts
// 原型片段：实际成员 ID 必须来自 scene/assembly 工具。
const initial = api.scene.transforms.capture(["entity:motion-root"]);
api.scene.transforms.rotate(initial, [0,0,0], [0,1,0], Math.PI/4);
api.scene.transforms.rotate(initial, [0,0,0], [0,1,0], Math.PI/2);
// 两次是相对同一起点的绝对角度，总计 90°，不是 135°。
```

## 固定失败用例与数据验收

Agent Play 从暂停的初始状态启动。用 pointer-gesture 连续执行前置手势（例如先转动相机、再连续转不同层），在最后一次调用提供 caseLabel 保存整段序列；显式期望失败也会自动保存。最多 32 个手势、64 个项目用例。通过外部输入或单独 play.step 改变运行状态会使录制不可完整重放，工具明确返回 saved:false，需重新从初始 Play 录制。

```json
{
 "caseLabel":"顶面向右拖拽后只转动选中层，其他层和相机不动",
 "points":[{"phase":"down","x":0.5,"y":0.3},{"phase":"move","x":0.6,"y":0.3},{"phase":"move","x":0.7,"y":0.3},{"phase":"up","x":0.7,"y":0.3}],
 "settleTicks":30,
 "expect":{
  "cameraChanged":false,
  "rotation":{"entityIds":["entity:motion-root"],"pivot":[0,0,0],"axis":[0,1,0],"angleDegrees":90,"requireIntermediate":true}
 }
}
```

上例 ID、输入、轴、角度仅示意，必须从具体需求、对象数据与相机方向确定。rotation 检查每个成员的 worldMatrix 与理论旋转结果，同时检查未选成员不变、后代随父一起变换。requireIntermediate 检查松手前的真实中间变换；提交后的 observe("angle",90) 无法通过。

验收断言使用 `evidence state signal effects.rotationMatched equals true` 和 `effects.intermediateMotion equals true`，绑定该手势的 state observation。错误详情在 effects.rotationMismatches；position/rotation/scale 为父局部，state.entities[].worldMatrix 为世界列主序 4×4。

修复后 `play.regression {"action":"list"}` 获取原始 caseId，再从初始 Play 执行 `{"action":"replay","caseId":"返回的ID"}`。基线检查相机、视口、seed 和初始变换，防止换场景/换位置测“另一个成功用例”。不能通过改写原期望掩盖失败。项目日志跨对话、重启保留定义与结果；task.evaluate 要求保留用例在当前修订通过。

每个用户反馈缺陷形成具名用例。旋转至少覆盖反向、其他可见面、相机移动后、连续跨轴、同轴四次恢复、操作与逆操作，以及装饰面片上的命中；每次修复保留原用例重新测。数据正确之后，仅渲染外观再做多模态验证。
