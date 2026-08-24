# M12 G01: M06 cross-genre baseline

Binding：`m12-g01-2026-08-24`  
Machine source：[`m12-g01-baseline.json`](./m12-g01-baseline.json)

## Result

七类任务均在 reviewed M06 revision `e4625bb62cfc973c60957997429876a0b455166a` 的 capability preflight 阶段确定性阻塞。该 revision 的 13 个生产工具只能读取项目/实体/脚本/诊断，编辑 primitive Scene/Transform，提交单脚本并启动/停止 preview；它没有 fixed-step、input injection/replay、gameplay state inspection、Agent screenshot capture 或 acceptance evaluator。

因此 G01 没有向真实 Provider 发送明知无法产生验收证据的请求，也没有修改生产 Prompt/工具来粉饰基线。每个 case 明确记录：`terminal=blocked`、mutation/preview/tool/latency 为零、token 为 null、cost unknown，并列出缺失 capability 与 evidence gap。

这份结果只证明 M06 无法测量七类游戏完成度，不代表模型本身无法生成代码。后续 G12 必须用同一 case ids 对 cold-create、warm-repair 和 seeded-defect 做真实、可观测的双 Backend 测量。

## Evidence interpretation

- `null` token 表示没有 Provider request，不能当作零成本模型执行。
- `wallLatencyMs=0` 表示 preflight 同步拒绝，不是端到端性能。
- `preview.started=false` 是 capability gate 结果，不是运行失败截图。
- 所有 case 都缺少 acceptance result，因此严禁将任一 case 标为完成或通过。
