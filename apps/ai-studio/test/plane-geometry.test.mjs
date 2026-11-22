import test from 'node:test';
import assert from 'node:assert/strict';
import { Entity, Mesh3D } from '@haiyue/engine';
import { createAuthoringPlane } from '@haiyue/ai-studio-editor-plugins/render';
import { attachSceneEntityVisuals } from '../dist/scene-entity-rendering.js';

test('instance-array picking includes the near plane and handles both projections and reverse Z under transformed parents',async()=>{
 const {Camera3D,CartesianTransform3D,SphericalTransform3D,Transform3D}=await import('@haiyue/engine/components');
 const {parseParametricArray}=await import('@haiyue/ai-studio-contracts');
 const {parametricArrayVisualState,pickParametricArray,refreshParametricArrayVisual}=await import('../dist/parametric-array-visuals.js');
 const {playWorldMatrix}=await import('../dist/play-transforms.js');
 const {multiply,inverse,transformPoint}=await import('@haiyue/ai-studio-script-preview/transforms');
 const spec=parseParametricArray({schemaVersion:1,arrayId:'pickable',representation:'instances',layout:{kind:'grid',rows:2,columns:3,origin:{x:-.4,y:-.4,z:0},spacing:{x:.4,y:.4}},template:{kind:'rounded-box',radius:.1,scale:{x:.3,y:.3,z:.3}}});
 const parent=new Entity('Parent').addComponent(new CartesianTransform3D({position:[2,0,0],rotation:[0,0,Math.PI/2],scale:[1.5,1.5,1.5]})),root=new Entity('Array').addComponent(new CartesianTransform3D());parent.addChild(root);
 attachSceneEntityVisuals(root,{kind:'rounded-box',components:[{type:'haiyue.scene.array',value:spec}]});
 const initial=parametricArrayVisualState(root);assert.equal(initial.count,6);assert.ok(Math.abs(initial.sample[0].position[0]-2.6)<1e-5);
 for(const type of ['orthographic','perspective'])for(const reverseZ of [false,true]){
  const projection=new Camera3D({type,near:.1,far:1000,fov:Math.PI/3});projection.reverseZ=reverseZ;
  if(type==='orthographic'){projection.orthoLeft=-10;projection.orthoRight=10;projection.orthoTop=8;projection.orthoBottom=-8;}
  const camera=new Entity('Camera').addComponent(projection).addComponent(new SphericalTransform3D({radius:24,theta:0,phi:Math.PI/2}));
  const point=parametricArrayVisualState(root).sample[0].position,clip=transformPoint(multiply(projection.projectionMatrix,inverse(playWorldMatrix(camera))),point);
  const hit=pickParametricArray(camera,clip[0],clip[1],[root]);assert.equal(hit?.entity,root);assert.equal(hit?.key,'0:0');
 }
 parent.getComponent(CartesianTransform3D).setPosition(3,0,0);refreshParametricArrayVisual(root);
 assert.ok(Math.abs(parametricArrayVisualState(root).sample[0].position[0]-3.6)<1e-5);
});

test('authoring and preview planes share vertices, front normals and UV orientation in all three planes', () => {
  for (const [plane, normal] of [[undefined, 2], ['xy', 2], ['xz', 1], ['yz', 0]]) {
    const expected = createAuthoringPlane(plane);
    const entity = new Entity('Plane');
    attachSceneEntityVisuals(entity, { kind: 'plane', components: [{ type: 'haiyue.render.geometry', value: { kind: 'plane', ...(plane ? { plane } : {}) } }] });
    const actual = entity.getComponent(Mesh3D).geometry;
    assert.deepEqual(actual.positions, expected.positions); assert.deepEqual(actual.normals, expected.normals);
    for (let i = 0; i < actual.positions.length; i += 3) {
      assert.equal(actual.positions[i + normal], 0);
      assert.equal(actual.normals[i + normal], 1);
    }
    for (const axis of [0, 1, 2].filter(axis => axis !== normal)) assert.ok([...actual.positions].filter((_, index) => index % 3 === axis).some(value => value !== 0));
    entity.removeComponent(Mesh3D);
  }
  assert.throws(() => createAuthoringPlane('zx'), /Geometry plane/);
});

test('rounded-box authoring and Play share real curved geometry, bounds, radius and subdivision settings', async () => {
  const { createAuthoringRoundedBox } = await import('@haiyue/ai-studio-editor-plugins/render');
  const { createBox3D } = await import('@haiyue/engine');
  for (const value of [{}, { radius: 0.15, segments: 6 }, { radius: 0.5, segments: 1 }, { radius: 0, segments: 4 }]) {
    const expected = createAuthoringRoundedBox(value);
    const entity = new Entity('Rounded');
    attachSceneEntityVisuals(entity, { kind: 'rounded-box', components: [{ type: 'haiyue.render.geometry', value: { kind: 'rounded-box', ...value } }] });
    const actual = entity.getComponent(Mesh3D).geometry;
    assert.deepEqual(actual.positions, expected.positions); assert.deepEqual(actual.normals, expected.normals);
    for (const axis of [0, 1, 2]) {
      const coords = [...actual.positions].filter((_, i) => i % 3 === axis);
      assert.equal(Math.min(...coords), -0.5); assert.equal(Math.max(...coords), 0.5);
    }
    if (value.radius !== 0) {
      assert.ok(actual.positions.length > createBox3D().positions.length);
      assert.ok([...actual.normals].some(n => Math.abs(n) > 0.01 && Math.abs(n) < 0.99), 'rounded corners must contain smooth off-axis normals');
      assert.equal([...actual.positions].some((_, i, p) => i % 3 === 0 && p.slice(i, i + 3).every(n => Math.abs(n) === 0.5)), false, 'sharp box corners must be absent');
    } else assert.deepEqual(actual.positions, createBox3D().positions);
    entity.removeComponent(Mesh3D);
  }
});
