import { defineQRCodeComponents, type HYQRCode } from '@haiyue/ui/qr-code';
import type { HYDialog } from '@haiyue/ui/dialog';
import type { MobilePreviewInfo } from './mobile-preview-server.js';
import { updateToolbarButton } from './toolbar.js';

interface ShareUiPorts {
  readonly desktop: boolean;
  readonly language: () => 'zh-CN' | 'en';
  readonly game: () => Readonly<{planId:string;viewport:Readonly<{width:number;height:number}>}> | null;
  readonly invoke: (method:'preview/share-start'|'preview/share-stop',payload:Record<string,unknown>,signal?:AbortSignal)=>Promise<unknown>;
}
export function mountMobilePreviewSharing(document:Document,ports:ShareUiPorts) {
  defineQRCodeComponents();
  const lifetime=new AbortController(),button=document.getElementById('play-share') as HTMLButtonElement;
  const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const value=document.createElement(tag);value.textContent=text;return value;};
  const dialog=document.createElement('hy-dialog') as HYDialog;dialog.id='mobile-preview-dialog';dialog.dismissible=true;
  const body=node('div');body.className='mobile-share-content';
  const hint=node('p'),status=node('p');status.setAttribute('role','status');
  const addresses=node('select');addresses.id='mobile-share-address';addresses.setAttribute('aria-label','预览网络地址');
  const qr=document.createElement('hy-qr-code') as HYQRCode;qr.size=220;qr.color='#10131c';qr.backgroundColor='#ffffff';qr.setAttribute('aria-label','手机运行二维码');
  const url=node('input');url.id='mobile-share-url';url.readOnly=true;url.setAttribute('aria-label','手机预览链接');
  const copy=node('button'),certificate=node('button'),stop=node('button'),done=node('button');for(const control of [copy,certificate,stop,done])control.type='button';
  const fingerprint=node('code');fingerprint.className='mobile-share-fingerprint';
  const trust=node('details'),summary=node('summary'),explanation=node('p');trust.append(summary,explanation,fingerprint,certificate);
  const actions=node('div');actions.className='mobile-share-actions';actions.append(copy,stop);body.append(hint,addresses,qr,url,actions,trust,status);
  done.slot='footer';dialog.append(body,done);document.body.append(dialog);
  let info:MobilePreviewInfo|null=null,pending:AbortController|null=null,certificateUrl:string|null=null,generation=0;
  const text=(zh:string,en:string)=>ports.language()==='zh-CN'?zh:en;
  const clear=()=>{info=null;qr.value='';url.value='';fingerprint.textContent='';addresses.replaceChildren();copy.disabled=certificate.disabled=true;if(certificateUrl){URL.revokeObjectURL(certificateUrl);certificateUrl=null;}};
  const select=()=>{const selected=info?.urls[Number(addresses.value)];qr.value=selected?.url??'';url.value=selected?.url??'';copy.disabled=certificate.disabled=!selected;};
  function locale():void{
    updateToolbarButton(button,text('扫码运行','Run on phone'),'qr');dialog.heading=text('手机扫码运行','Run on your phone');
    hint.textContent=text('手机与电脑连接同一局域网。游戏会铺满手机当前可用屏幕，并随横竖屏自动调整；停止预览或修改工程会结束分享。','Connect both devices to the same network. The game fills the phone screen and adapts to rotation. Stopping Play or editing ends sharing.');
    copy.textContent=text('复制链接','Copy link');stop.textContent=text('停止分享','Stop sharing');done.textContent=text('完成','Done');
    summary.textContent=text('首次连接与证书','First connection and certificate');certificate.textContent=text('下载本机预览证书','Download preview certificate');
    explanation.textContent=text('首次打开 HTTPS 链接需信任本机预览证书。仅信任你自己电脑生成、指纹一致的证书。iPhone 安装后需在“设置 → 通用 → 关于本机 → 证书信任设置”启用完全信任。链接最长有效 30 分钟。','Trust this computer’s preview certificate on first use and verify its fingerprint. On iPhone, enable full trust in Settings → General → About → Certificate Trust Settings. Links expire within 30 minutes.');
  }
  function parse(value:unknown):MobilePreviewInfo{
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid share response');
    const v=value as Record<string,unknown>;
    if(!Array.isArray(v.urls)||!v.urls.length||v.urls.length>16||typeof v.fingerprint!=='string'||v.fingerprint.length>200||typeof v.certificateBase64!=='string'||v.certificateBase64.length>32768||!Number.isFinite(v.expiresAt)||!Number.isSafeInteger(v.documentRevision))throw Error('Invalid share response');
    for(const item of v.urls){if(!item||typeof item!=='object'||typeof item.label!=='string'||item.label.length>200||typeof item.url!=='string'||item.url.length>2048)throw Error('Invalid share address');const parsed=new URL(item.url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||!/^\/s\/[A-Za-z0-9_-]{32}\/$/u.test(parsed.pathname))throw Error('Invalid share address');}
    return v as unknown as MobilePreviewInfo;
  }
  const open=async()=>{
    const game=ports.game();if(!game||!ports.desktop)return;
    locale();dialog.showModal();
    pending?.abort();clear();const controller=new AbortController();pending=controller;const current=++generation;
    button.disabled=true;status.textContent=text('正在启动 HTTPS 预览…','Starting HTTPS preview…');
    try{
      const result=parse(await ports.invoke('preview/share-start',game,controller.signal));
      if(current!==generation||controller.signal.aborted)return;info=result;
      result.urls.forEach((entry,index)=>{const option=node('option',entry.label);option.value=String(index);addresses.append(option);});
      addresses.value='0';select();fingerprint.textContent=result.fingerprint;status.textContent=text('扫码后在手机浏览器中点击“开始游戏”。','Scan, then tap Start in your browser.');
    }catch(cause){if(current===generation&&!controller.signal.aborted)status.textContent=cause instanceof Error?cause.message.slice(0,500):text('分享启动失败','Could not start sharing');}
    finally{if(current===generation){pending=null;button.disabled=!ports.game();}}
  };
  button.hidden=!ports.desktop;const tooltip=button.closest<HTMLElement>('hy-tooltip');if(tooltip)tooltip.hidden=!ports.desktop;
  button.addEventListener('click',()=>void open(),{signal:lifetime.signal});
  addresses.addEventListener('change',select,{signal:lifetime.signal});
  done.addEventListener('click',()=>dialog.close('action'),{signal:lifetime.signal});
  dialog.addEventListener('dialog-close',()=>{if(pending){generation++;pending.abort();pending=null;void ports.invoke('preview/share-stop',{}).catch(()=>{});}button.disabled=!ports.game();button.focus();},{signal:lifetime.signal});
  copy.addEventListener('click',()=>{void navigator.clipboard.writeText(url.value).then(()=>{if(!lifetime.signal.aborted)status.textContent=text('链接已复制','Link copied');}).catch(()=>{if(!lifetime.signal.aborted){url.select();status.textContent=text('请选择并复制上方链接','Select and copy the link above');}});},{signal:lifetime.signal});
  stop.addEventListener('click',()=>{const current=++generation;pending?.abort();pending=null;clear();button.disabled=!ports.game();void ports.invoke('preview/share-stop',{}).then(()=>{if(!lifetime.signal.aborted&&current===generation)status.textContent=text('分享已停止，再次点击“扫码运行”可生成新链接。','Sharing stopped. Use Run on phone to generate another link.');}).catch(()=>{});},{signal:lifetime.signal});
  certificate.addEventListener('click',()=>{if(!info)return;if(!certificateUrl){const bytes=Uint8Array.from(atob(info.certificateBase64),c=>c.charCodeAt(0));certificateUrl=URL.createObjectURL(new Blob([bytes],{type:'application/x-x509-ca-cert'}));}const link=node('a');link.href=certificateUrl;link.download='Haiyue-Preview-CA.cer';link.click();},{signal:lifetime.signal});
  clear();locale();
  return {
    refresh(){locale();button.disabled=!ports.game()||pending!==null;if(!ports.game()){generation++;pending?.abort();pending=null;clear();dialog.close('programmatic');}},
    dispose(){generation++;pending?.abort();lifetime.abort();clear();dialog.remove();},
  };
}
