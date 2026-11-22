import {HaiyueEngine,Entity,CartesianTransform3D} from '@haiyue/engine';
import {applyProjectCamera} from '@haiyue/ai-studio-editor-plugins/camera-authoring';
import {SharedGeometryPool} from '@haiyue/ai-studio-editor-plugins/render';
import {attachSceneEntityVisuals,installSceneEntityMaterialRenderers} from '../../dist/scene-entity-rendering.js';
import {refreshParametricArrays,parametricArrayVisualState,pickParametricArray} from '../../dist/parametric-array-visuals.js';
import {playWorldMatrix} from '../../dist/play-transforms.js';
import {Camera3D} from '@haiyue/engine/components';
import {multiply,inverse,transformPoint} from '@haiyue/ai-studio-script-preview/transforms';
for(const event of ['error','unhandledrejection'])window.addEventListener(event,value=>{document.body.dataset.arrayError=String(value.message??value.reason);document.body.dataset.arrayStatus='failed';});
const data=await(await fetch('data.json')).json(),canvas=document.querySelector('canvas');
const engine=new HaiyueEngine({canvas,devicePixelRatio:1,msaaSamples:1,clearColor:{r:.015,g:.015,b:.025,a:1}});await engine.init();
const scene=engine.createScene({name:'Parameterized editor preview',render3D:true});applyProjectCamera(scene,data.snapshot.camera,canvas.width/canvas.height);installSceneEntityMaterialRenderers(engine,scene);
const native=new Map(),pool=new SharedGeometryPool();
for(const item of data.snapshot.entities){const entity=new Entity(item.name).addComponent(new CartesianTransform3D({position:Object.values(item.transform.position),rotation:Object.values(item.transform.rotationDegrees).map(v=>v*Math.PI/180),scale:Object.values(item.transform.scale)}));attachSceneEntityVisuals(entity,item,pool);native.set(item.id,entity);}
for(const item of data.snapshot.entities){const entity=native.get(item.id);if(item.parentId)native.get(item.parentId).addChild(entity);else scene.add(entity);}
refreshParametricArrays(native.values());engine.switchScene(scene);engine.run();
await new Promise(resolve=>{let count=0;const frame=()=>++count<12?requestAnimationFrame(frame):resolve();requestAnimationFrame(frame);});
window.arrayEditorState=parametricArrayVisualState(native.get(data.arrayRoot));
const camera=scene.activeCameraEntity,clip=transformPoint(multiply(camera.getComponent(Camera3D).projectionMatrix,inverse(playWorldMatrix(camera))),window.arrayEditorState.sample[0].position);
const picked=pickParametricArray(camera,clip[0],clip[1],native.values());
if(picked?.entity!==native.get(data.arrayRoot)||picked.key!=='0:0')throw Error('Editor cannot pick the rendered array cell: '+JSON.stringify({clip,picked:picked?{key:picked.key,point:picked.point}:null,camera:Array.from(playWorldMatrix(camera)),cell:window.arrayEditorState.sample[0]}));
document.body.dataset.arrayStatus='editor-ready';
window.disposeArrayEditor=()=>engine.destroy();
window.addEventListener('beforeunload',()=>engine.destroy(),{once:true});
window.runArrayPlay=()=>new Promise((resolve,reject)=>{
 engine.stop();const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.src='haiyue-preview://app/preview.html';document.body.append(frame);
 let result=null,capture=null,stopping=false;const timer=setTimeout(()=>{window.removeEventListener('message',listener);reject(Error('Play deadline'));},30000);
 const send=value=>frame.contentWindow.postMessage({protocol:'haiyue-preview/1',...value},'*');
 const listener=event=>{
  if(event.source!==frame.contentWindow||event.data?.protocol!=='haiyue-preview/1')return;
  const message=event.data;
  if(['runtime-error','start-failed','request-failed'].includes(message.type)){clearTimeout(timer);window.removeEventListener('message',listener);reject(Error(JSON.stringify(message)));}
  else if(message.type==='ready')send({type:'start',scene:data.snapshot,plan:data.plan,assets:[],paused:true});
  else if(message.type==='started')send({type:'step',requestId:'array:step',count:1});
  else if(message.type==='stepped')send({type:'inspect',requestId:'array:inspect'});
  else if(message.type==='inspection'){
   result=message.value.state.entities.find(e=>e.id===data.arrayRoot)?.instances;
   if(!result||result.count!==400||result.sample[0].position.some(v=>v!==0)){clearTimeout(timer);reject(Error(JSON.stringify(message.value)));return;}
   send({type:'capture',requestId:'array:capture'});
  }else if(message.type==='capture'){
   capture={base64:message.base64,byteLength:message.byteLength};stopping=true;send({type:'stop'});
  }else if(message.type==='cleanup-complete'&&stopping){
   clearTimeout(timer);window.removeEventListener('message',listener);frame.remove();resolve({play:result,capture,cleanup:message.disposableCount});
  }
 };
 window.addEventListener('message',listener);
});
