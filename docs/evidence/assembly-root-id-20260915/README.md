# assembly.create 根节点 ID 冲突回归

原因与修复见 [架构记录](../../architecture/assembly-root-id-domains.md)。以失败日志中的 toolCallId 计算隐式根 ID，结果与实际 duplicate 错误匹配；未保存用户原始日志或蓝图。

`tests.log`：6 项通过，包括同批重复实体的原子回滚、合法 root 部件的创建与实例化、父子映射、Undo/Redo、保存重开和既有组合原型约束。`build.log` 与 `app.log` 为通过的构建输出。

用户当前项目未修改，应用未重启。

`check.log`：全仓检查通过类型、边界等前置检查后，仍受既有 M14 capability census 验证指纹过期阻挡；未重录基线。
