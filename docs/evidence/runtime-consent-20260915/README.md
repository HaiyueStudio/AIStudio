# 重复运行审批与规划内脚本授权

原因与授权边界见 [架构记录](../../architecture/task-script-preview-consent.md)。本轮未重启应用或修改用户当前工程。

- `matching.log`：两项恢复授权测试，通过相同运行摘要的新句柄复用，拒绝任务、文档、工具、修订、预览内容等变化及二次消费。
- `host.log`：两项真实 Host 测试，规划批准后脚本不再增加人工审批；普通编辑的持久审批恢复仍生效。
- `tools-final.log`：三项工具回归，验证重复运行复用授权、新代码重新确认、prepare 后撤销授权以及既有可逆编辑授权范围。
- `runtime-full.log`：完整工具 runtime 回归 77 项全部通过。
- `scope.log`：既有预览授权隔离测试通过，覆盖本地重启恢复、源码/权限变化和更换文档。
- `build.log` / `shell.log`：工具、编排、Shell 和应用构建通过。
- `check.log`：全仓检查在 M14 capability census 的旧验证基线指纹处失败；未重新录制基线或改变里程碑状态。

日志仅含隔离测试输出，不含用户原始会话和游戏脚本。
