import { HaiyueEngine, Entity, CartesianTransform3D } from '@haiyue/engine';
import { DEFAULT_PROJECT_CAMERA, applyProjectCamera } from '@haiyue/ai-studio-editor-plugins/camera-authoring';
import { attachSceneEntityVisuals } from '../../dist/scene-entity-rendering.js';
let engine;
const transform = {position:{x:0,y:0,z:0},rotationDegrees:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}};
window.transparencyTest = {
 async prepare(options) {
  const scene = {documentId:'document:alpha',revision:1,camera:{...DEFAULT_PROJECT_CAMERA,projection:'orthographic',azimuthDegrees:0,elevationDegrees:90,orthographicSize:10},assets:[],entities:[
   {id:'entity:background',name:'White background',kind:'plane',parentId:null,order:0,transform:{...transform,scale:{x:8,y:8,z:8}},appearance:{material:'basic',color:[1,1,1,1]},components:[{id:'component:plane',type:'haiyue.render.geometry',version:'1.0.0',enabled:true,value:{kind:'plane',plane:'xz'}}]},
   {id:'entity:alpha',name:'Transparent cube',kind:'cube',parentId:null,order:1,transform:{...transform,position:{x:0,y:2,z:0},scale:{x:3,y:3,z:3}},appearance:{material:'basic',color:[0,0,0,options.alpha],...options.policy},components:[]},
  ]};
  let canvas=document.getElementById('author');if(!canvas){canvas=document.createElement('canvas');canvas.id='author';canvas.style.cssText='width:640px;height:480px;display:block';document.body.append(canvas);}canvas.width=640;canvas.height=480;
  engine=new HaiyueEngine({canvas,renderProfile:'batched',clearColor:{r:.03,g:.03,b:.03,a:1}});await engine.init();
  const world=engine.createScene({name:'Transparency',render3D:true});applyProjectCamera(world,scene.camera,640/480);
  for(const item of scene.entities){const entity=new Entity(item.name);entity.addComponent(new CartesianTransform3D({position:Object.values(item.transform.position),scale:Object.values(item.transform.scale)}));attachSceneEntityVisuals(entity,item);world.add(entity);}
  engine.switchScene(world);engine.resizeToDisplaySize(true);engine.run();
  const plan={id:'preview-plan:alpha',documentId:scene.documentId,documentRevision:1,selection:'all-enabled',scriptSetDigest:'sha256:'+'b'.repeat(64),scripts:[{scriptId:'script:alpha',entityId:'entity:alpha',order:0,textRevision:1,digest:'sha256:'+'a'.repeat(64),capabilities:['read'],diagnostics:[],emittedText:''}],capabilities:['read'],runtimeConfig:{schemaVersion:1,mode:'fixed-step',tickRateHz:60,maxSubSteps:1000,seed:'haiyue-play'},risk:'trusted-project',diagnostics:[]};
  return {scene,plan};
 },
 async pixel(base64) {
  const image=await createImageBitmap(await (await fetch('data:image/png;base64,'+base64)).blob());
  const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const c=canvas.getContext('2d');c.drawImage(image,0,0,640,480);image.close();
  return [...c.getImageData(320,240,1,1).data];
 },
 async dispose(){await engine?.device.queue.onSubmittedWorkDone();engine?.destroy();engine=null;},
};
