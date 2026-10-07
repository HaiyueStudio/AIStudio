import type { JsonObject } from '@haiyue/ai-studio-contracts';
import type { StudioIpcMethod } from './ipc.js';

export function mountToolSettings(document: Document, parent: HTMLElement, ports: { invoke(method: StudioIpcMethod, payload?: JsonObject): Promise<JsonObject>; language(): 'zh-CN' | 'en' }) {
  const lifetime = new AbortController(), root = document.createElement('fieldset'); root.id = 'tool-settings';
  const legend = document.createElement('legend'); root.append(legend);
  const controls = ['web','browser','node'].map(key => { const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span'); input.type = 'checkbox'; input.disabled = true; input.dataset.toolCapability = key; label.append(input, text); root.append(label); return { key, input, text }; });
  const backendLabel = document.createElement('label'), backendText = document.createElement('span'), backend = document.createElement('select');
  for (const name of ['playwright','chrome-devtools']) { const option = document.createElement('option'); option.value = name; option.textContent = name; backend.append(option); }
  backend.disabled = true; backendLabel.className = 'tool-backend-setting'; backendLabel.append(backendText, backend); root.append(backendLabel);
  const parallel = document.createElement('p'); root.append(parallel);
  const experiments = document.createElement('p'); experiments.dataset.experimentalAdmission = 'true'; root.append(experiments);
  const status = document.createElement('p'), button = document.createElement('button'), hint = document.createElement('p'); button.type = 'button'; button.disabled = true; status.setAttribute('role','status'); root.append(hint,button,status); parent.append(root);
  let state: JsonObject | null = null;
  function refreshLocale() {
    const zh = ports.language() === 'zh-CN'; legend.textContent = zh ? 'Agent 扩展工具' : 'Agent extended tools';
    backendText.textContent = zh ? '浏览器后端（Chrome DevTools 为实验功能）' : 'Browser backend (Chrome DevTools is experimental)';
    hint.textContent = zh ? '设置保存后重启应用生效。工具仍使用现有审批、预算和取消流程。环境检测失败的能力不会发送给模型。' : 'Restart to apply. Approval, budgets and cancellation still apply. Unavailable capabilities are hidden from the model.';
    button.textContent = zh ? '保存工具设置' : 'Save tool settings';
    const reasons: Record<string, string> = zh ? { 'backend-unsupported': '当前 Agent 后端不支持', disabled: '已关闭', ready: '环境可用', 'ready; search requires credentials': '抓取可用；搜索需要配置凭据', 'browser-executable-unavailable': '未检测到可执行的浏览器', 'platform-sandbox-unavailable': '当前系统暂无受限执行适配', 'node-22-or-sandbox-unavailable': '需要 Node.js 22+ 及系统沙箱', 'qualification-bundle-unavailable': '缺少并行资格证据', 'qualification-required-per-plan': '已载入证据，每次计划仍需校验', 'qualification-bundle-invalid-or-stale': '资格证据无效或已过期', 'build-identity-unavailable': '无法验证当前构建' } : {};
    for (const c of controls) {
      const value = (state?.capabilities as JsonObject | undefined)?.[c.key] as JsonObject | undefined;
      c.text.textContent = `${({web: zh ? '网络搜索 / 抓取' : 'Web search / fetch', browser: zh ? '浏览器' : 'Browser', node: 'Node.js'} as Record<string,string>)[c.key]} · ${value?.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '不可用 / 关闭' : 'Unavailable / off')} · ${value?.backend ?? ''} · ${reasons[String(value?.reason)] ?? value?.reason ?? ''}`;
    }
    const p = (state?.capabilities as JsonObject | undefined)?.parallel as JsonObject | undefined;
    parallel.textContent = `${zh ? '受控并行' : 'Controlled parallelism'} · ${reasons[String(p?.reason)] ?? p?.reason ?? (zh ? '不可用' : 'Unavailable')}`;
    experiments.textContent = zh ? '官方 Team 暂不可用：任务恢复尚不能受 Studio 统一管理。Stagehand 暂不可用：额外推理缺少用量报告和请求限额。' : 'Official Team is unavailable: recovery cannot yet use Studio authority. Stagehand is unavailable: auxiliary inference has no usage reporting or request caps.';
    if (state?.restartRequired) status.textContent = zh ? '已保存，重启应用后生效。' : 'Saved. Restart to apply.';
  }
  void ports.invoke('tools/settings').then(value => { if (lifetime.signal.aborted) return; state = value; const prefs = value.preferences as JsonObject; if (!prefs) throw new Error(); controls.forEach(c => { c.input.checked = prefs[c.key] === true; c.input.disabled = false; }); backend.value = String(prefs.browserBackend); backend.disabled = false; button.disabled = false; refreshLocale(); }).catch(() => { if (!lifetime.signal.aborted) status.textContent = ports.language() === 'zh-CN' ? '工具配置暂不可用' : 'Tool settings unavailable'; });
  button.addEventListener('click', async () => { button.disabled = true; try { const preferences = { browserBackend: backend.value, ...Object.fromEntries(controls.map(c => [c.key, c.input.checked])) }; const value = await ports.invoke('tools/configure',{preferences}); if (!lifetime.signal.aborted) { state = value; refreshLocale(); } } catch { if (!lifetime.signal.aborted) status.textContent = ports.language() === 'zh-CN' ? '保存失败' : 'Save failed'; } finally { if (!lifetime.signal.aborted) button.disabled = false; } }, {signal:lifetime.signal});
  refreshLocale(); return { refreshLocale, dispose() { lifetime.abort(); root.remove(); } };
}
