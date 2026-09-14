import type { JsonObject } from '@haiyue/ai-studio-contracts';
import type { StudioIpcMethod } from './ipc.js';

export function mountQuerySettings(document: Document, parent: HTMLElement, ports: {
  invoke(method: StudioIpcMethod, payload?: JsonObject): Promise<JsonObject>;
  language(): 'zh-CN' | 'en';
}) {
  const lifetime = new AbortController();
  const root = document.createElement('fieldset'); root.id = 'query-settings';
  const legend = document.createElement('legend'); root.append(legend);
  const entries = [['engine.docs.search', '引擎文档', 'Engine documentation'], ['tool.search', '工具与组件', 'Tools and components'], ['scene.query', '场景对象', 'Scene objects'], ['scene.diff', '场景变更', 'Scene changes']];
  const controls = entries.map(([id, zh, en]) => {
    const label = document.createElement('label'), span = document.createElement('span'), input = document.createElement('input');
    input.type = 'number'; input.min = '1'; input.step = '1'; input.required = true; input.disabled = true; input.dataset.queryTool = id;
    label.append(span, input); root.append(label); return { id: id!, zh: zh!, en: en!, span, input };
  });
  const hint = document.createElement('p'), button = document.createElement('button'), status = document.createElement('p');
  button.type = 'button'; button.disabled = true; status.setAttribute('role', 'status');
  root.append(hint, button, status); parent.append(root);
  function refreshLocale() {
    const zh = ports.language() === 'zh-CN'; legend.textContent = zh ? 'Agent 查询额度' : 'Agent query allowances';
    controls.forEach(c => c.span.textContent = zh ? c.zh : c.en);
    button.textContent = zh ? '保存查询额度' : 'Save query allowances';
    hint.textContent = zh ? '每次查询的默认数量与确认阈值。超出时可选择扩大本次额度，或按当前上限继续；较多结果会分页返回。偏好保存在当前设备。' : 'Default quantity and confirmation threshold per query. Larger requests ask for an increase or continue at this limit. Results may be paginated. Saved on this device.';
  }
  void ports.invoke('queries/get').then(result => {
    if (lifetime.signal.aborted) return;
    const limits = result.limits as JsonObject;
    for (const c of controls) { c.input.value = String(limits[c.id]); c.input.disabled = false; }
    button.disabled = false;
  }).catch(() => { if (!lifetime.signal.aborted) status.textContent = ports.language() === 'zh-CN' ? '查询设置暂不可用。' : 'Query settings unavailable.'; });
  button.addEventListener('click', async () => {
    const limits: Record<string, number> = {};
    for (const c of controls) {
      const count = Number(c.input.value);
      if (!Number.isSafeInteger(count) || count < 1) { c.input.setCustomValidity(ports.language() === 'zh-CN' ? '请输入正整数。' : 'Enter a positive integer.'); c.input.reportValidity(); return; }
      c.input.setCustomValidity(''); limits[c.id] = count;
    }
    button.disabled = true;
    try { await ports.invoke('queries/set', { limits }); if (!lifetime.signal.aborted) status.textContent = ports.language() === 'zh-CN' ? '已保存，将用于后续查询。' : 'Saved for subsequent queries.'; }
    catch { if (!lifetime.signal.aborted) status.textContent = ports.language() === 'zh-CN' ? '保存失败，请重试。' : 'Could not save. Try again.'; }
    finally { if (!lifetime.signal.aborted) button.disabled = false; }
  }, { signal: lifetime.signal });
  refreshLocale();
  return { refreshLocale, dispose() { lifetime.abort(); root.remove(); } };
}
