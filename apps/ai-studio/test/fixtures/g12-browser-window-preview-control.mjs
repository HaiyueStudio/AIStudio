export class BrowserWindowPreviewControl {
  #sequence = 0;
  #snapshot = Object.freeze({ instanceId: null, state: 'stopped', scriptSetDigest: null, scriptCount: 0, scripts: Object.freeze([]), entityId: null, position: null, disposableCount: 0, errors: Object.freeze([]) });

  constructor(window) { this.window = window; }

  async ready(timeoutMs = 30_000) {
    await this.window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const deadline = Date.now() + ${timeoutMs}; const poll = () => { if (document.body.dataset.previewReady === 'true') resolve(true); else if (Date.now() > deadline) reject(new Error('G12 preview iframe readiness timeout')); else setTimeout(poll, 25); }; poll(); })`);
  }

  async start(scene, plan, signal) { return this.#lifecycle('start', { scene, plan }, signal); }
  async stop(signal) { return this.#lifecycle('stop', {}, signal); }
  async step(count, signal) { return this.#invoke('step', { count }, signal); }
  async input(event, signal) { return this.#invoke('input', { event }, signal); }
  async inspect(signal) { return this.#invoke('inspect', {}, signal); }
  async capture(signal) { return this.#invoke('capture', {}, signal); }
  snapshot() { return this.#snapshot; }

  async #lifecycle(kind, payload, signal) {
    const value = await this.#invoke(kind, payload, signal);
    this.#snapshot = Object.freeze(value);
    return this.#snapshot;
  }

  async #invoke(kind, payload, signal) {
    if (signal?.aborted) throw signal.reason ?? new Error('Preview command aborted.');
    const id = `g12-preview-command:${++this.#sequence}`;
    const command = { id, kind, ...payload };
    const execution = this.window.webContents.executeJavaScript(`window.g12PreviewCommand(${JSON.stringify(command)})`);
    if (!signal) return execution;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('Preview command aborted.'));
      signal.addEventListener('abort', abort, { once: true });
      execution.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}
