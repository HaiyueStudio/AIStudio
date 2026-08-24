(() => {
  const localized = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  let delayedTimer = null;

  const ensureDiagnostic = () => {
    let diagnostic = document.getElementById('startup-diagnostic');
    if (diagnostic) return diagnostic;
    diagnostic = document.createElement('section');
    diagnostic.id = 'startup-diagnostic';
    diagnostic.setAttribute('role', 'alert');
    diagnostic.hidden = true;
    const title = document.createElement('strong');
    title.id = 'startup-diagnostic-title';
    const detail = document.createElement('span');
    detail.id = 'startup-diagnostic-detail';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = localized('重新加载', 'Reload');
    retry.addEventListener('click', () => location.reload());
    diagnostic.append(title, detail, retry);
    document.body.append(diagnostic);
    return diagnostic;
  };

  const fail = (reason) => {
    if (document.body.dataset.status === 'ready') return;
    if (delayedTimer !== null) clearTimeout(delayedTimer);
    document.body.dataset.status = 'error';
    document.body.dataset.startupStage = 'failed';
    const message = reason instanceof Error ? reason.message : String(reason || localized('未知启动错误', 'Unknown startup error'));
    const status = document.getElementById('status');
    if (status) status.textContent = localized('AIStudio 启动失败', 'AIStudio failed to start');
    const diagnostic = ensureDiagnostic();
    document.getElementById('startup-diagnostic-title').textContent = localized('编辑器界面未能加载', 'The editor UI could not load');
    document.getElementById('startup-diagnostic-detail').textContent = message;
    diagnostic.hidden = false;
  };

  window.addEventListener('error', (event) => fail(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => fail(event.reason));
  window.addEventListener('haiyue-startup-failed', (event) => fail(event.detail));

  delayedTimer = window.setTimeout(() => {
    if (document.body.dataset.status !== 'loading') return;
    const status = document.getElementById('status');
    if (status) status.textContent = localized('AIStudio 仍在启动，请稍候…', 'AIStudio is still starting…');
  }, 15_000);

  new MutationObserver(() => {
    if (document.body.dataset.status !== 'loading' && delayedTimer !== null) {
      clearTimeout(delayedTimer);
      delayedTimer = null;
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['data-status'] });
})();
