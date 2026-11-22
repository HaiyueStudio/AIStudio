import { loadPreviewAssets, releasePreviewAssetUrls, type PreviewAssetManifestEntry, type PreviewAssetReadResult, type PreviewRuntimeAsset } from './preview-asset-transfer.js';
import type { StableId } from '@haiyue/ai-studio-contracts';
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const intro = element('intro'), stage = element('mobile-stage'), frame = element<HTMLIFrameElement>('mobile-frame');
const status = element('mobile-status'), start = element<HTMLButtonElement>('mobile-start');
const lifetime = new AbortController();
let run: AbortController | null = null, assets: readonly PreviewRuntimeAsset[] = [], generation = 0;
let watch: ReturnType<typeof setInterval> | null = null;
const record = (value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const send = (value: Record<string,unknown>) => frame.contentWindow?.postMessage({protocol:'haiyue-preview/1',...value},'*');
function fit(): void {
  const viewport = window.visualViewport;
  stage.style.width = Math.max(1, Math.floor(viewport?.width ?? innerWidth)) + 'px';
  stage.style.height = Math.max(1, Math.floor(viewport?.height ?? innerHeight)) + 'px';
}
function stop(message = '游戏已退出'): void {
  generation++; run?.abort(); run = null;
  send({type:'stop'}); frame.removeAttribute('src'); releasePreviewAssetUrls(assets); assets = [];
  if (watch) { clearInterval(watch); watch = null; }
  stage.hidden = true; intro.hidden = false; status.textContent = message; start.disabled = false;
  document.body.dataset.game = 'stopped';
}
async function play(): Promise<void> {
  stop('正在载入游戏…');
  const current = ++generation;
  run = new AbortController(); const signal = run.signal; start.disabled = true;
  try {
    const response = await fetch('./snapshot.json',{signal,cache:'no-store'});
    if (!response.ok) throw Error('分享已结束，请在编辑器中重新生成二维码。');
    const value: unknown = await response.json();
    if (!record(value) || !record(value.scene) || !record(value.plan) || !record(value.viewport)
      || typeof value.name !== 'string' || value.name.length > 200
      || typeof value.scene.documentId !== 'string' || !Number.isSafeInteger(value.scene.revision)
      || !Array.isArray(value.scene.entities) || value.scene.entities.length > 10000
      || !Array.isArray(value.scene.assets) || value.scene.assets.length > 128) throw Error('预览数据无效。');
    for (const key of ['width','height']) if (!Number.isSafeInteger(value.viewport[key])
      || Number(value.viewport[key]) < 240 || Number(value.viewport[key]) > 3840) throw Error('预览尺寸无效。');
    const descriptors: PreviewAssetManifestEntry[] = value.scene.assets.map((item: unknown) => {
      if (!record(item) || typeof item.id !== 'string' || !/^asset:[a-f0-9]{24}$/u.test(item.id)
        || !['texture','model','audio','animation'].includes(String(item.kind))
        || typeof item.mimeType !== 'string' || item.mimeType.length > 128
        || !Number.isSafeInteger(item.byteLength) || Number(item.byteLength) < 1 || Number(item.byteLength) > 32*1024*1024
        || !Number.isSafeInteger(item.decodedBytes) || Number(item.decodedBytes) < 1 || Number(item.decodedBytes) > 256*1024*1024) throw Error('预览资源描述无效。');
      return {id:item.id as StableId,kind:item.kind as PreviewAssetManifestEntry['kind'],mimeType:item.mimeType,byteLength:Number(item.byteLength),decodedBytes:Number(item.decodedBytes)};
    });
    const loaded = await loadPreviewAssets({assets:descriptors,entities:[{components:[{enabled:true,value:{ids:descriptors.map(d=>d.id)}}]}]}, async id => {
      const asset = await fetch('./assets/' + id.slice(6),{signal,cache:'no-store'});
      if (!asset.ok) throw Error('预览资源已失效。');
      const result: unknown = await asset.json();
      if (!record(result) || typeof result.assetId !== 'string' || typeof result.kind !== 'string'
        || typeof result.mimeType !== 'string' || !Number.isSafeInteger(result.byteLength)
        || typeof result.base64 !== 'string') throw Error('资源响应无效。');
      return result as PreviewAssetReadResult;
    }, undefined, signal);
    if (current !== generation) { releasePreviewAssetUrls(loaded); return; }
    assets = loaded;
    element('game-name').textContent = value.name; document.title = value.name;
    intro.hidden = true; stage.hidden = false; fit();
    const listener = (event: MessageEvent<unknown>) => {
      if (current !== generation || event.source !== frame.contentWindow || !record(event.data)
        || event.data.protocol !== 'haiyue-preview/1') return;
      if (event.data.type === 'ready') send({type:'start',scene:value.scene,plan:value.plan,assets,paused:false,cameraFit:'short-axis'});
      else if (event.data.type === 'started') { document.body.dataset.game = 'playing'; frame.focus(); }
      else if (event.data.type === 'failed' || event.data.type === 'runtime-error') {
        stop(typeof event.data.message === 'string' ? event.data.message.slice(0,500) : '游戏运行失败。');
      }
    };
    window.addEventListener('message',listener,{signal});
    frame.src = './preview.html';
    watch = setInterval(() => {
      void fetch('./status.json',{signal,cache:'no-store'}).then(r => {
        if (!r.ok && current === generation) stop('编辑器已停止分享。');
      }).catch(() => { if (current === generation) stop('与编辑器的连接已断开。'); });
    },3000);
  } catch (cause) {
    if (current !== generation) return;
    stop(cause instanceof Error ? cause.message : '游戏加载失败。');
  }
}
if (!isSecureContext || !navigator.gpu) {
  status.textContent = !isSecureContext ? '请先信任本机预览证书，再重新打开此链接。' : '当前浏览器不支持 WebGPU，请使用支持 WebGPU 的浏览器。';
} else {
  status.textContent = '点击开始，在此设备独立运行当前游戏。'; start.disabled = false;
}
start.addEventListener('click',()=>void play(),{signal:lifetime.signal});
element('mobile-restart').addEventListener('click',()=>void play(),{signal:lifetime.signal});
element('mobile-exit').addEventListener('click',()=>stop(),{signal:lifetime.signal});
element('mobile-fullscreen').addEventListener('click',()=>{void document.documentElement.requestFullscreen?.().catch(()=>{});},{signal:lifetime.signal});
window.addEventListener('resize',fit,{signal:lifetime.signal});
window.visualViewport?.addEventListener('resize',fit,{signal:lifetime.signal});
document.addEventListener('fullscreenchange',fit,{signal:lifetime.signal});
window.addEventListener('pagehide',()=>{stop();lifetime.abort();},{once:true});
