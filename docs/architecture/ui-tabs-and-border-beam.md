# 工作区 Tab 与等待卡片组件修复

逻辑/资源切换使用 `@haiyue/ui/tabs` 的 `hy-tabs`，通过 `options`、`value`、具名 slot 和
`tab-change` 连接工作区。内容节点保留，工作区只负责保存选中项及显示状态；组件负责
鼠标、方向键、Home/End、焦点和 ARIA。中英文切换、经典/意图布局之间的移动不会清空选项。

点击拓扑节点、缩放或切换完整记录会重绘聊天卡片。旧版 `hy-border-beam` 构造函数间接调用
外观更新，在 `document.createElement` 返回前写入宿主 style 属性，导致浏览器抛出
`NotSupportedError: The result must not have attributes`，并留下未正确升级的元素。
UI 修复将宿主外观更新放在连接/属性变化阶段，构造阶段只建立 shadow 内容。动画和观察器
清理保留，未通过吞掉异常或改变拓扑记录规避问题。

AIStudio 锁定仓库内 `vendor/haiyue-ui-0.1.3.tgz`，没有引用跨仓源码或修改安装目录。
[候选来源与校验值](../../config/upstream/ui-candidate.json) 记录 UI 基础提交、工作区文件摘要、
tarball 摘要、lock integrity 和公共导出决定；现有能力检查同时校验候选包、安装版本与公共入口。
本次只制作本地候选，未发布 npm 包。

验证包括 UI 构造/观察器生命周期测试、真实 Electron 中的 Tab 键盘与鼠标切换、禁用项、
单次变更事件、语言切换、内容节点身份和布局重挂载，以及带等待卡片反复操作执行图。
旧依赖真实复现日志保留在 `test-output/diagnostics/ui-beam-before-fix.log`；
当前完整验收见 [组合验收记录](./m14-integration-acceptance.md)。
