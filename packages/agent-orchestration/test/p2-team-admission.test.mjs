import test from 'node:test';
import assert from 'node:assert/strict';
import { teamAdmission } from '../dist/team-admission.js';
test('Team inspection is a detached projection of the existing approved plan, not another task board',()=>{
 const plan={title:'Review',summary:'Two steps',attempts:0,mutationCount:0,items:[{id:'step:one',label:'Read',execution:{id:'task:one',dependsOn:[],writeScopes:[]},executionStatus:'completed'},{id:'step:two',label:'Compare',execution:{id:'task:two',dependsOn:['task:one'],writeScopes:[]},executionStatus:'running'}]};
 const view=teamAdmission(undefined,true,plan);
 assert.equal(view.upstreamTeamMounted,false);assert.equal(view.nativeAdmission,'blocked');assert.equal(view.taskAuthority,'studio-approved-plan');assert.equal(view.status,'qualification-required');
 assert.equal(view.tasks[0].status,'completed');assert.equal(view.tasks[1].stepId,'step:two');
 view.tasks[1].dependsOn.push('forged');assert.deepEqual(plan.items[1].execution.dependsOn,['task:one']);
 plan.items[1].executionStatus='completed';assert.equal(teamAdmission(undefined,true,plan).tasks[1].status,'completed');
 assert.deepEqual(teamAdmission().tasks,[]);
});
