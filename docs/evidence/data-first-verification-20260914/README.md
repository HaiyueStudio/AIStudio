# 数据优先验收 · 2026-09-14

按验收项选择数据读取或视觉检查；规划、批准后执行、检查点续跑和修复均携带这个策略。
默认 prompt 更新为 3.9.0 / general-authoring 1.6.0，压缩常驻说明，操作细节通过文档搜索按需获取。

play.inspect 新增可选 entityIds 和 includeGameplay；省略时保持原行为。选中对象按请求顺序返回，
明确 missingEntityIds、totalEntityCount、坐标空间和查询范围。持久化的是同一份选中数据，
评估器路径与模型看到的路径一致。保留相机、事件和全局运行错误。
此轮选择发生在工具接收现有 Play 快照后，减少持久化和模型数据量；尚未减少 renderer 内部全场景快照/IPC 成本。

验证：
- tools-test：9 项通过，含 400 对象中末尾目标查询、缺失 ID、参数拒绝、真实变换与脚本上报分离、零 capture 调用、手势证据有界投影。
- orchestration-test：4 项通过，含新建/恢复任务能力一致、按项验证路径、续跑上下文预算。
- evidence-test：17 项通过，含计划校验、视觉证据不能代替语义验证、同 tick/同 Play/同 revision 绑定与分阶段证据。
- docs-test：1 项通过，验证新增指南可检索和读取。
- prompt-test：15 项通过，含长请求/历史/工具场景下 98304 字节预算、genre-neutral、缓存和持久化。
- Agent runtime、tools、orchestration 与桌面 app 构建通过；git diff --check 通过。
- root check 仍被已有 M14 capability census 验证输入绑定不匹配阻塞；未重新采集或修改门禁基线。

未调用真实模型或多模态服务，未量化 token/延迟节约，未重启用户正在运行的应用。
当前确定性评估器仍无自动视觉分析生产器：真实渲染要求保留图像审阅，不能把截图存在或配置正确宣称为外观通过。
