# 组合原型 root 部件与隐式根节点冲突

2026-09-15 用户首步 `assembly.create` 失败：Document 报实体重复，查询仍为 r1/0 实体，assembly registry 中不存在该组合。

日志蓝图包含 `key: root` 的 empty 部件，body 和六个贴片都以它作为 parentKey。旧实现生成隐式根节点的 role 为 `0:root`，该部件的 role 也为 `0:root`。两者在同一调用中哈希出同一个 entity ID。用失败日志的 toolCallId 重新计算，确认该 ID 与报错值相同。

这是同一事务内的重复添加。Document 在异常时逆序应用已成功操作的 inverse 并恢复 revision，registry 的 setting.set 也未提交。因此 r1/0 实体和 assembly.missing 是正常回滚结果，没有证据表明存在需要清理的预留记录。

现在隐式根节点仍使用 `<ordinal>:root`，用户部件使用 `<ordinal>:part:<key>`。蓝图允许的 key 不含冒号，因此两个命名空间不相交。`root` 是合法部件名，不需要禁止它。已保存原型的实体 ID 不变；实例化仍按保存的绑定重映射引用，无需数据迁移。

回归覆盖：

- 重建旧式同批 ID 冲突，验证实体、revision 和 registry 完整回滚。
- 使用同一调用身份和合法 root 蓝图成功创建原型。
- 复制后所有 ID 唯一，body → root 部件 → 隐式根的父子关系正确。
- 撤销、重做、保存重开后结构检查通过。
- 现有材质部件、需求校验、指针配置继承和原型修订保护回归通过。

未提供清理内部预留状态的工具，也未修改用户运行中的项目。更新应用后可重新尝试原 assembly.create 请求。
