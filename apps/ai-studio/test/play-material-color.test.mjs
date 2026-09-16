import test from 'node:test';
import assert from 'node:assert/strict';
import { Entity, Mesh3D, BasicMaterial, PbrMaterial, createBox3D } from '@haiyue/engine';
import { BlinnPhongMaterial } from '@haiyue/engine/material';
import { readPlayMaterialColor, setPlayMaterialColor } from '../dist/play-material-color.js';

test('runtime color uses actual material setters, preserves properties and isolates shared materials',()=>{
 for (const material of [new BasicMaterial(),new PbrMaterial({roughness:.27,metallic:.8}),new BlinnPhongMaterial({shininess:48})]) {
  const a=new Entity('A'),b=new Entity('B'),geometry=createBox3D();
  a.addComponent(new Mesh3D(geometry,material));b.addComponent(new Mesh3D(geometry,material));
  const original=readPlayMaterialColor(b);
  setPlayMaterialColor(a,[.2,.4,.8,1],[a,b]);
  assert.deepEqual(readPlayMaterialColor(b),original);
  const isolated=a.getComponent(Mesh3D).material;
  assert.notEqual(isolated,material);
  if(material instanceof PbrMaterial) {assert.equal(isolated.roughness,.27);assert.equal(isolated.metallic,.8);}
  const revision=isolated.revision;
  setPlayMaterialColor(a,[1,0,0,1],[a,b]);
  assert.equal(a.getComponent(Mesh3D).material,isolated);
  assert.ok(isolated.revision>revision);assert.deepEqual(readPlayMaterialColor(a),[1,0,0,1]);
  for(const value of [[NaN,0,0,1],[2,0,0,1],[1,0,0]])assert.throws(()=>setPlayMaterialColor(a,value,[a,b]));
  a.destroy();b.destroy();
 }
 assert.throws(()=>setPlayMaterialColor(new Entity('Camera'),[1,0,0,1],[]),/Mesh3D/);
});


test('Basic alpha auto mode survives shared-material isolation and honors authored overrides', async () => {
 const { createAuthoringBasicMaterial } = await import('@haiyue/ai-studio-editor-plugins/render');
 const { attachSceneEntityVisuals } = await import('../dist/scene-entity-rendering.js');
 const a = new Entity('transparent'), b = new Entity('shared');
 attachSceneEntityVisuals(a, { kind:'cube', appearance:{ material:'basic', color:[0,0,0,.01] } });
 const source = a.getComponent(Mesh3D).material;
 b.addComponent(new Mesh3D(createBox3D(), source));
 assert.equal(source.blending, 'normal'); assert.equal(source.depthWrite, false);
 setPlayMaterialColor(a, [0,0,0,1], [a,b]);
 const isolated = a.getComponent(Mesh3D).material;
 assert.notEqual(source, isolated);
 assert.equal(isolated.blending, 'none'); assert.equal(isolated.depthWrite, true);
 assert.equal(source.blending, 'normal'); assert.ok(readPlayMaterialColor(b)[3] < .011);
 setPlayMaterialColor(a, [0,0,0,0], [a,b]);
 assert.equal(isolated.blending, 'normal'); assert.equal(isolated.depthWrite, false);
 for (const [options, expected] of [[{blending:'none'},['none',true]], [{blending:'normal',depthWrite:true},['normal',true]], [{blending:'additive'},['additive',false]]]) {
  a.getComponent(Mesh3D).material = createAuthoringBasicMaterial([0,0,0,1], options);
  setPlayMaterialColor(a,[0,0,0,.01],[a,b]);
  assert.deepEqual([a.getComponent(Mesh3D).material.blending,a.getComponent(Mesh3D).material.depthWrite],expected);
 }
 a.destroy(); b.destroy();
});
