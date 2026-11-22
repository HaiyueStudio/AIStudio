import { createServer, type Server } from 'node:https';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { mobilePreviewIdentity, type CertificateProtector } from './mobile-preview-certificates.js';
import type { SceneSnapshot } from '@haiyue/ai-studio-editor-plugins';
import type { PreviewPlan } from '@haiyue/ai-studio-script-preview';
import type { PreviewAssetReadResult } from './preview-asset-transfer.js';

export interface MobilePreviewPackage { readonly scene: Pick<SceneSnapshot,'documentId'|'revision'|'entities'|'camera'> & {readonly assets:readonly Readonly<{id:string;kind:string;mimeType:string;byteLength:number;decodedBytes:number}>[]}; readonly plan: PreviewPlan; readonly assets:readonly PreviewAssetReadResult[]; readonly viewport:Readonly<{width:number;height:number}>; readonly name:string; }
export interface MobilePreviewInfo { readonly urls:readonly Readonly<{label:string;url:string}>[]; readonly expiresAt:number; readonly fingerprint:string; readonly certificateBase64:string; readonly documentRevision:number; }
interface Address { readonly name:string; readonly address:string; }
export function mobilePreviewAddresses(): readonly Address[] { return Object.entries(networkInterfaces()).flatMap(([name,values])=>(values??[]).filter(v=>v.family==='IPv4'&&!v.internal&&!v.address.startsWith('169.254.')).map(v=>({name,address:v.address}))).slice(0,16); }

/** One revocable, immutable game snapshot; never an editor IPC or filesystem server. */
export class MobilePreviewServer {
  private server:Server|null=null; private info:MobilePreviewInfo|null=null; private generation=0;
  private readonly starts=new Set<Promise<MobilePreviewInfo>>();
  private expiry:ReturnType<typeof setTimeout>|null=null; private readonly sockets=new Set<Duplex>(); private disposed=false;
  private disposal: Promise<void> | null = null;
  constructor(private readonly options:Readonly<{dist:string;certificateDirectory:string;protector:CertificateProtector;addresses?:()=>readonly Address[];listenHost?:string;ttlMs?:number}>){ }
  current():MobilePreviewInfo|null{return this.info;}
  start(game:MobilePreviewPackage,signal?:AbortSignal):Promise<MobilePreviewInfo>{
    const task=this.startInternal(game,signal);this.starts.add(task);
    void task.then(()=>this.starts.delete(task),()=>this.starts.delete(task));return task;
  }
  private async startInternal(game:MobilePreviewPackage,signal?:AbortSignal):Promise<MobilePreviewInfo>{
    if(this.disposed)throw Error('mobile-preview.disposed');
    const generation=++this.generation;await this.closeServer();
    const addresses=this.options.addresses?.()??mobilePreviewAddresses();
    if(!addresses.length)throw Error('mobile-preview.no-network: 未检测到局域网地址，请连接 Wi-Fi 或以太网。');
    const identity=await mobilePreviewIdentity(this.options.certificateDirectory,addresses.map(a=>a.address),this.options.protector);
    const files=new Map<string,Readonly<{bytes:Buffer;mime:string}>>();
    const add=async(name:string,mime:string)=>files.set(name,{bytes:await readFile(path.join(this.options.dist,name)),mime});
    for(const name of ['mobile-player.html','mobile-player.css','mobile-player.js','preview.html','preview.css','preview-runtime.js'])await add(name,name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':'text/javascript');
    for(const name of await readdir(path.join(this.options.dist,'chunks')))if(/^[a-z0-9-]+\.js$/iu.test(name))await add(`chunks/${name}`,'text/javascript');
    if(this.disposed||generation!==this.generation||signal?.aborted)throw Error('mobile-preview.cancelled');
    const id=randomBytes(24).toString('base64url'),prefix=`/s/${id}/`,ttl=Math.min(30*60_000,this.options.ttlMs??30*60_000),expiresAt=Date.now()+ttl;
    const snapshot=Buffer.from(JSON.stringify({scene:game.scene,plan:game.plan,viewport:game.viewport,name:game.name}));
    if(snapshot.length>8*1024*1024||game.assets.reduce((n,a)=>n+a.byteLength,0)>64*1024*1024)throw Error('mobile-preview.budget-exceeded');
    const assets=new Map(game.assets.map(asset=>[`assets/${asset.assetId.slice(6)}`,Buffer.from(JSON.stringify(asset))]));
    const allowed=new Set(['localhost','127.0.0.1',...addresses.map(a=>a.address)]);
    const ownedSockets=new Set<Duplex>();
    const server=createServer({key:identity.key,cert:identity.cert+'\n'+identity.ca,minVersion:'TLSv1.2',handshakeTimeout:10_000},(request,response)=>{
      const reply=(status:number,bytes:Buffer|string,mime='text/plain; charset=utf-8',cors=false)=>{response.writeHead(status,{'content-type':mime,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-opener-policy':'same-origin',...(cors?{'access-control-allow-origin':'*','cross-origin-resource-policy':'cross-origin'}:{'cross-origin-resource-policy':'same-origin'})});response.end(request.method==='HEAD'?undefined:bytes);};
      try{
        const url=new URL(request.url??'/',`https://${request.headers.host??'invalid'}`);
        if(url.protocol!=='https:'||url.username||url.password||!allowed.has(url.hostname)||url.port!==String((server.address() as {port:number}).port)||!['GET','HEAD'].includes(request.method??'')||url.search||url.hash||Date.now()>=expiresAt||!url.pathname.startsWith(prefix)){reply(404,'Preview unavailable');return;}
        const resource=url.pathname.slice(prefix.length)||'mobile-player.html';
        if(resource==='snapshot.json'){if(request.headers.origin&&request.headers.origin!==url.origin){reply(403,'Forbidden');return;}reply(200,snapshot,'application/json');return;}
        if(resource==='status.json'){reply(200,'{"active":true}','application/json');return;}
        if(resource==='certificate.cer'){response.setHeader('content-disposition','attachment; filename="Haiyue-Preview-CA.cer"');reply(200,Buffer.from(identity.publicCertificate),'application/x-x509-ca-cert');return;}
        const asset=assets.get(resource);if(asset){reply(200,asset,'application/json');return;}
        const file=files.get(resource);if(!file){reply(404,'Not found');return;}reply(200,file.bytes,file.mime,resource.endsWith('.js')||resource.endsWith('.css'));
      }catch{reply(400,'Bad request');}
    });
    server.requestTimeout=10_000;server.headersTimeout=10_000;server.maxHeadersCount=40;server.maxConnections=32;
    server.on('connection',socket=>{ownedSockets.add(socket);this.sockets.add(socket);socket.on('close',()=>{ownedSockets.delete(socket);this.sockets.delete(socket);});});
    const closeOwned=async()=>{for(const socket of ownedSockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));};
    this.server=server;
    try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,this.options.listenHost??'0.0.0.0',()=>{server.off('error',reject);resolve();});});}
    catch{if(this.server===server)await this.closeServer();else await closeOwned();throw Error('mobile-preview.listen-failed: 无法启动 HTTPS 预览服务。');}
    if(this.disposed||generation!==this.generation||signal?.aborted){if(this.server===server)await this.closeServer();else await closeOwned();throw Error('mobile-preview.cancelled');}
    const port=(server.address() as {port:number}).port;
    this.info=Object.freeze({urls:addresses.map(a=>({label:`${a.name} · ${a.address}`,url:`https://${a.address}:${port}${prefix}`})),expiresAt,fingerprint:identity.fingerprint,certificateBase64:Buffer.from(identity.publicCertificate).toString('base64'),documentRevision:game.scene.revision});
    this.expiry=setTimeout(()=>{void this.stop();},ttl);this.expiry.unref();
    return this.info;
  }
  async stop():Promise<void>{
    this.generation++;await this.closeServer();
  }
  private async closeServer():Promise<void>{
    this.info=null;if(this.expiry){clearTimeout(this.expiry);this.expiry=null;}
    const server=this.server;this.server=null;
    for(const socket of this.sockets)socket.destroy();this.sockets.clear();
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
  dispose():Promise<void>{if(this.disposal)return this.disposal;this.disposed=true;return this.disposal=(async()=>{await this.stop();await Promise.allSettled([...this.starts]);})();}
}
