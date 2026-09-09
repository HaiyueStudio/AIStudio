from pathlib import Path
import json
root = Path('D:/HaiyueStudio/AIStudio')
out = root / 'apps/ai-studio/test/m14-integration/test-output'
r = json.loads((out / 'local-acceptance.json').read_text(encoding='utf-8'))
assert r['uiComponents']['focusedChecks'] == 55 and r['rootCheck']['exitCode'] == 0
binding = r['inputBinding']; tests = r['integration']; evidence = len(r['evidence'])
summary = f"2026-09-09 当前冻结输入：`{binding['digest']}`（{binding['fileCount']} 个输入文件）。工作区公共 Tab 与边框组件创建修复后，`npm run check` 以 0 退出；{r['capabilityChecks']} 项能力验证通过，{tests['files']} 个集成测试文件共 {tests['passed']} 项通过，无失败或跳过。机器可读结果及 {evidence} 份证据摘要见 [本地验收记录](../../apps/ai-studio/test/m14-integration/test-output/local-acceptance.json)。记录保留 `productIntegrated: false`；修改前的 23 份证据已核验并归档于 `test-output/diagnostics/before-ui-tabs/`。"
followup = "本轮界面跟进：逻辑/资源使用 `@haiyue/ui/tabs` 公共组件；保留鼠标与键盘、ARIA、中英文、选中项持久化及布局重挂载。边框动画组件的构造阶段不再写入宿主 style，修复等待卡片重绘时的 `NotSupportedError`。55 项专项检查通过，包括 UI 24 项、shell 27 项、布局合同 1 项及 3 项真实窗口回归；反复点击拓扑、切换完整记录、缩放、拖动及重载均无组件创建错误。UI 0.1.3 本地候选来源、摘要、lock 与安装内容一致，没有发布远程包。原错误及两处旧测试假设的诊断日志保留在 `test-output/diagnostics/ui-*.log`。见 [修复说明](./ui-tabs-and-border-beam.md)。"
p = root / 'docs/architecture/m14-integration-acceptance.md'
lines = p.read_text(encoding='utf-8').splitlines()
for i,line in enumerate(lines):
    if line.startswith('2026-09-09 当前冻结输入：'): lines[i] = summary + '\n\n' + followup
    if line.startswith('本轮素材与方向跟进：'): lines[i] = line.replace('本轮素材与方向跟进：', '前次素材与方向跟进（历史记录，见归档）：', 1)
    if line.startswith('当前测量：'):
        perf=r['performance']; t=perf['timings']; scan=json.loads((out/'secret-scan.json').read_text(encoding='utf-8')); product=r['productScan']
        lines[i] = f"当前测量：打开项目 {round(t['open'])} ms，高级面板挂载 {round(t['advancedMount'])} ms，筛选并选择末尾实体 {round(t['filterAndSelect'])} ms，资源查询 {round(t['resourceQuery'])} ms；五次关闭/重开面板后 renderer 堆从 {perf['initialHeapBytes']:,} 增至 {perf['finalHeapBytes']:,} 字节，均在冻结预算内。扫描通过：临时产品目录 {product['files']} 个文件/约 {product['bytes']/1000000:.1f} MB，当前与诊断证据 {scan['files']} 个文件/约 {scan['bytes']/1000000:.1f} MB；产品没有生成 crash dump，扫描器另有跨数据块及 UTF-16 二进制泄漏检测回归。"
p.write_text('\n'.join(lines)+'\n',encoding='utf-8')
p = Path('D:/HaiyueStudio/milestones/milestones/m14-ai-native-intent-graph-editor/README.md')
lines = p.read_text(encoding='utf-8').splitlines()
for i,line in enumerate(lines):
    if line.startswith('2026-09-09 G09 本地总检查已通过：'):
        lines[i] = f"2026-09-09 G09 本地总检查已通过：工作区 Tab 与等待卡片边框组件修复后的当前输入为 `{binding['digest']}`（{binding['fileCount']} 个输入文件），{r['capabilityChecks']} 项能力验证及 {tests['files']} 文件/{tests['passed']} 项集成测试通过，无跳过；55 项专项检查通过。逻辑/资源改用公共 Tab，键盘、语言、布局重挂载及选择保持通过；边框组件不再在创建阶段写宿主属性，带等待卡片反复操作拓扑无组件错误。UI 0.1.3 候选包已校验并锁定。此前 Canvas 素材、平面方向、图形拖动和会话修复的证据保留，本轮没有发起在线任务。七类游戏双回放、生产窗口、项目记录、交互预算及扫描通过。见 [机器可读本地结果](../../../AIStudio/apps/ai-studio/test/m14-integration/test-output/local-acceptance.json) 与 [修复说明](../../../AIStudio/docs/architecture/ui-tabs-and-border-beam.md)。在线双后端与最终六层准入仍未完成，G09 为 blocked，product-integrated 不提升。"
    if line.startswith('阻塞复核：'):
        lines[i] = '阻塞复核：向 DeepSeek API、Codex App Server 发送生成的临时测试项目及工具参数仍待明确授权；自动审批此前已拒绝该发送操作。Tab 与组件构造修复已重新冻结 AIStudio 输入并完成本地总检查，修改前的 23 份证据已核验归档；UI 候选升至 0.1.3，Editor 候选没有变化。历史只读就绪检查不代替真实在线任务验收；收到授权后从当前冻结组合继续在线验收与最终准入，不重写 M12/M13 历史状态。'
p.write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('Updated UI repair acceptance documents without changing Goal status.')
