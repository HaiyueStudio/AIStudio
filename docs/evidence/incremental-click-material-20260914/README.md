# 增量点击改色 · 2026-09-14

实际任务日志显示：立方体有 click 指针组件；相机脚本读取全局 interactions，并筛选真实立方体 ID。
点击后 script-reported click-count 从 0 变 1，因此脚本挂在相机上并不是事件不触发的原因。
旧脚本把 getComponent("haiyue.material.pbr") 返回值强制当作材质，后来改为写其 data.baseColor，
但这不等于更新 Mesh3D.material；它同时上报一个新颜色，掩盖了实际渲染效果未改变的问题。
颜色选择是顺序轮换，也不满足随机选择。未复制用户完整日志或修改当前工程。

通用修复：
- selfInteractions 返回当前脚本宿主的命中事件；原 interactions 保持全局语义，允许明确设计的跨对象控制器。
- setMaterialColor 通过实际 Basic/PBR/Blinn-Phong 材质 setter 更新 sRGB RGBA，触发 revision，保留贴图/参数；共享材质按目标隔离。
- play.inspect state.entities.materialColor 读取真实渲染材质颜色因子，不依赖脚本上报。它不是最终像素颜色，仍需视觉检查光照/纹理效果。
- 编译检查拦截将编辑器材质类型 ID 传给 getComponent 的常见错误；提案返回实际宿主及 pointer events，没有自身指针组件时给出提示。
- 增量工具说明明确局部行为新增在目标上、保留相机职责；提供可检索点击随机改色示例，排除上一次颜色。

验证：
- Script compiler 专项通过：新 API 类型有效，错误 descriptor 写法在 Play 前拒绝。
- Tool proposal 专项通过：返回实际宿主与未配置指针事件的提示。
- 实际 Engine 材质测试通过：Basic/PBR/Blinn-Phong、revision、共享材质隔离、参数保留和非法输入。
- Electron/WebGPU fixture 通过：40 个既有拾取点、原有拖拽/投影回归，新增两个独立脚本的 3 次原生点击、空白点击、拖拽不改色、Agent 点击。
- App/script/tools 构建通过。Root check 仍因现有 M14 verification input binding 不匹配失败，未修改该门禁基线。

未重启 AIStudio，未重写现有工程脚本。新接口需要新版本应用和重新校验后的脚本。
