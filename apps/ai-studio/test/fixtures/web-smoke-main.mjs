import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const target = process.env.HAIYUE_WEB_SMOKE_URL;
if (!target) throw new Error('HAIYUE_WEB_SMOKE_URL is required.');
if (process.env.HAIYUE_WEB_SMOKE_USER_DATA) app.setPath('userData', process.env.HAIYUE_WEB_SMOKE_USER_DATA);
const deadline = setTimeout(() => finish(1, 'deadline exceeded'), 60_000);
let finished = false;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.on('console-message', (_event, level, message) => console.log(`[web-renderer:${level}] ${message}`));
  window.webContents.once('did-fail-load', (_event, code, description) => finish(1, `load failed ${code}: ${description}`));
  await window.loadURL(target);
  try {
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 45000;
      let saveConfirmed = false;
      const wait = (test, done) => {
        if (test()) return done();
        if (Date.now() > deadline) return reject(new Error('web UI workflow timed out: ' + document.querySelector('#status')?.textContent));
        setTimeout(() => wait(test, done), 50);
      };
      wait(() => document.body.dataset.status === 'ready', () => {
        const defaultPreferences = document.body.dataset.language === 'zh-CN' && document.body.dataset.theme === 'dark';
        document.querySelector('#settings-button').click();
        const settingsOpened = document.querySelector('#settings-dialog')?.open === true;
        document.querySelector('#language-select').dispatchEvent(new CustomEvent('value-change', { detail: { value: 'en' } }));
        document.querySelector('#theme-select').dispatchEvent(new CustomEvent('value-change', { detail: { value: 'light' } }));
        document.querySelector('#settings-done').click();
        document.querySelector('#new-project').click();
        wait(() => document.querySelector('#project-name')?.textContent === 'HaiYue Game', () => {
          document.querySelector('#create-cube').click();
          wait(() => document.querySelectorAll('.entity').length === 1 && document.querySelector('#status')?.textContent === 'Ready', () => {
            document.querySelector('#save-project').click();
            wait(() => document.querySelector('#status')?.textContent === 'Project saved' && !document.querySelector('#save-project')?.textContent.includes('•'), () => {
              saveConfirmed = true;
              document.querySelector('.entity').click();
              wait(() => document.querySelector('#selection-label')?.textContent === 'Cube', () => {
              document.querySelector('#propose-script').click();
              wait(() => !document.querySelector('#commit-script').disabled, () => {
                document.querySelector('#commit-script').click();
                wait(() => !document.querySelector('#prepare-preview').disabled, () => {
                  document.querySelector('#run-project').click();
                  wait(() => document.querySelector('#run-dialog')?.open === true && !document.querySelector('#run-approve').disabled, () => {
                    document.querySelector('#run-approve').click();
                    wait(() => document.body.dataset.preview === 'playing' && document.querySelector('#run-project')?.textContent === '■ Stop', () => {
                      document.querySelector('#run-project').click();
                      wait(() => document.body.dataset.preview === 'stopped' && document.querySelector('#run-project')?.textContent === '▶ Run', () => resolve({
                        status: document.body.dataset.status,
                        shell: document.body.dataset.shell,
                        node: typeof process,
                        host: typeof window.haiyueStudio,
                        project: document.querySelector('#project-name')?.textContent,
                        entities: document.querySelectorAll('.entity').length,
                        selected: document.querySelector('#selection-label')?.textContent,
                        preview: document.body.dataset.preview,
                        webgpu: document.body.dataset.webgpu,
                        agentState: document.body.dataset.agentBackendState,
                        defaultPreferences,
                        settingsOpened,
                        language: document.body.dataset.language,
                        theme: document.body.dataset.theme,
                        settingsClosed: document.querySelector('#settings-dialog')?.open === false,
                        saveConfirmed,
                        runButtonConfirmed: true,
                      }));
                    });
                  });
                });
              });
              });
            });
          });
        });
      });
    })`);
    if (result.status !== 'ready' || result.shell !== 'web' || result.node !== 'undefined' || result.host !== 'object'
      || result.project !== 'HaiYue Game' || result.entities !== 1 || result.selected !== 'Cube' || result.preview !== 'stopped'
      || result.webgpu !== 'ready' || result.agentState !== 'unavailable' || result.defaultPreferences !== true
      || result.settingsOpened !== true || result.language !== 'en' || result.theme !== 'light' || result.settingsClosed !== true
      || result.saveConfirmed !== true || result.runButtonConfirmed !== true) {
      throw new Error(JSON.stringify(result));
    }
    await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const candidate = process.env.HAIYUE_WEB_SMOKE_PIXEL;
    if (candidate) { await mkdir(path.dirname(candidate), { recursive: true }); await writeFile(candidate, (await window.webContents.capturePage()).toPNG()); }
    finish(0, 'renderer-ready browser-host webgpu cube-created script-approved preview-stopped agent-desktop-only');
  } catch (cause) { finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)); }
}).catch((cause) => finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)));

function finish(code, message) {
  if (finished) return;
  finished = true; clearTimeout(deadline); console.log(`[ai-studio-web-smoke] ${message}`); app.exit(code);
}
