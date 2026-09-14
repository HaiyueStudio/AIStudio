import { HaiyueEngine, Entity, CartesianTransform3D } from '@haiyue/engine';
import { DEFAULT_PROJECT_CAMERA, applyProjectCamera } from '@haiyue/ai-studio-editor-plugins/camera-authoring';
import { attachSceneEntityVisuals, installSceneEntityMaterialRenderers } from '../../dist/scene-entity-rendering.js';
import { AuthoringMaterials } from '../../dist/authoring-materials.js';
import { loadPreviewAssets } from '../../dist/preview-asset-transfer.js';
import { AgentPreviewCursor } from '../../dist/agent-preview-cursor.js';
const assert = (condition, message) => { if (!condition) throw Error(message); };
const assetId = 'asset:0123456789abcdef01234567';
const comp = (type, value) => ({ id: 'component:'+type, type, version:'1.0.0', enabled:true, value });
const transform = { position:{x:0,y:0,z:0},rotationDegrees:{x:0,y:0,z:0},scale:{x:1,y:1,z:1} };
let engine, materials;
const cursor = new AgentPreviewCursor();
window.materialTest = {
 async prepare() {
  const source = document.createElement('canvas'); source.width = source.height = 256;
  const ctx=source.getContext('2d');ctx.fillStyle='#d6a45f';ctx.fillRect(0,0,256,256);ctx.fillStyle='#342016';
  for(let p=16;p<=240;p+=16){ctx.fillRect(p,16,3,224);ctx.fillRect(16,p,224,3);}
  const base64=source.toDataURL('image/png').split(',')[1];
  const asset={id:assetId,kind:'texture',mimeType:'image/png',byteLength:atob(base64).length,decodedBytes:256*256*4};
  const read=async()=>({assetId,kind:'texture',mimeType:asset.mimeType,byteLength:asset.byteLength,base64});
  const scene={documentId:'document:materials',revision:7,camera:{...DEFAULT_PROJECT_CAMERA,projection:'orthographic',azimuthDegrees:0,elevationDegrees:90,orthographicSize:10},assets:[asset],entities:[
   {id:'entity:board',name:'棋盘',kind:'plane',parentId:null,order:0,transform:{...transform,scale:{x:8,y:8,z:8}},appearance:{material:'pbr',color:[1,1,1,1]},components:[comp('haiyue.render.geometry',{kind:'plane',plane:'xz'}),comp('haiyue.material.pbr',{baseColor:[1,1,1,1],baseColorAssetId:assetId,metallic:0,roughness:1,doubleSided:true})]},
   {id:'entity:light',name:'Light',kind:'ambient-light',parentId:null,order:1,transform,light:{color:[1,1,1],intensity:1},components:[]},
  ]};
  window.testAssets=await loadPreviewAssets(scene,read);
  assert(window.testAssets[0].blob instanceof Blob && !window.testAssets[0].url,'transfer must carry bytes, not parent-origin URL');
  const canvas=document.createElement('canvas');canvas.id='author';canvas.width=640;canvas.height=480;canvas.style.cssText='width:640px;height:480px;display:block';document.body.append(canvas);
  engine=new HaiyueEngine({canvas,renderProfile:'batched',clearColor:{r:.03,g:.03,b:.03,a:1}});await engine.init();
  const world=engine.createScene({name:'Author',render3D:true});installSceneEntityMaterialRenderers(engine,world);applyProjectCamera(world,scene.camera,640/480);
  const entities=new Map();for(const item of scene.entities){const entity=new Entity(item.name);entity.addComponent(new CartesianTransform3D({position:[0,0,0],scale:Object.values(item.transform.scale)}));attachSceneEntityVisuals(entity,item);world.add(entity);entities.set(item.id,entity);}
  engine.switchScene(world);engine.resizeToDisplaySize(true);engine.run();
  materials=new AuthoringMaterials(read);await materials.apply(engine,world,scene,entities);
  const plan={id:'preview-plan:materials',documentId:scene.documentId,documentRevision:7,selection:'all-enabled',scriptSetDigest:'sha256:'+'b'.repeat(64),scripts:[{scriptId:'script:materials',entityId:'entity:board',order:0,textRevision:1,digest:'sha256:'+'a'.repeat(64),capabilities:['read'],diagnostics:[],emittedText:''}],capabilities:['read'],runtimeConfig:{schemaVersion:1,mode:'fixed-step',tickRateHz:60,maxSubSteps:1000,seed:'haiyue-play'},risk:'trusted-project',diagnostics:[]};
  window.materialScene=scene;window.materialPlan=plan;
  return {scene,plan};
 },
 async pixels(base64) {
  const image=await createImageBitmap(await (await fetch('data:image/png;base64,'+base64)).blob());
  const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const c=canvas.getContext('2d');c.drawImage(image,0,0,640,480);image.close();
  const values=c.getImageData(160,100,320,280).data;let yellow=0,dark=0,blue=0;const colors=new Map();
  for(let i=0;i<values.length;i+=4){const [r,g,b]=values.slice(i,i+3);if(r>90&&r>g*1.05&&g>b*1.15){yellow++;const key=[r,g,b].join(',');colors.set(key,(colors.get(key)??0)+1);}if(r<90&&g<90&&b<90)dark++;if(b>r*1.2&&b>80)blue++;}
  return {yellow,dark,blue,dominant:[...colors].sort((a,b)=>b[1]-a[1])[0][0].split(',').map(Number)};
 },
 cursor() {
  const frame=document.querySelector('iframe');const host=document.getElementById('cursor-test');
  const input=(phase,x,y)=>cursor.show(host,{kind:'pointer',phase,x,y,pointerId:1,button:0},'zh-CN');
  input('down',.25,.75);assert(host.querySelector('.agent-pointer').dataset.state==='down','press state');
  input('move',.75,.25);assert(host.querySelector('.agent-pointer').dataset.state==='drag','drag state');
  input('up',.75,.25);assert(host.querySelectorAll('.agent-pointer-mark').length===2,'press/release marks retained');
  const point=host.querySelector('.agent-pointer').getBoundingClientRect(),rect=frame.getBoundingClientRect();assert(Math.abs(point.left-rect.left-rect.width*.75)<1,'pointer x');assert(Math.abs(point.top-rect.top-rect.height*.25)<1,'pointer y');
  host.style.transformOrigin='top left';host.style.transform='scale(.5)';const scaled=host.querySelector('.agent-pointer').getBoundingClientRect(),fr=frame.getBoundingClientRect();assert(Math.abs(scaled.left-fr.left-fr.width*.75)<1,'scaled x');host.style.transform='';
  assert(getComputedStyle(host.querySelector('.agent-pointer-overlay')).pointerEvents==='none','overlay cannot capture input');
  cursor.clear();assert(!host.querySelector('.agent-pointer-overlay'),'reset cleanup');
  input('down',.5,.5);input('cancel',.5,.5);input('move',.5,.5);assert(host.querySelector('.agent-pointer').dataset.state==='move','cancel releases pointer');
  input('down',.3,.4);input('move',.6,.55);
  return true;
 },
 async disposeAuthor(){materials?.dispose();await engine?.device.queue.onSubmittedWorkDone();engine?.destroy();engine=null;},
 dispose(){cursor.dispose();materials?.dispose();engine?.destroy();assert(!document.querySelector('.agent-pointer-overlay'),'dispose cleanup');},
};
