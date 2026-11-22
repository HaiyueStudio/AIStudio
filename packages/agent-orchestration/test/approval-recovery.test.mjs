import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRecoveredApproval, matchesProjectToolApproval } from '../dist/approval-recovery.js';
const expected={taskId:'task:one',documentId:'document:one',toolId:'script.apply',toolVersion:'1',target:'script:one',baseRevision:8,argsDigest:'sha256:a',previewDigest:'sha256:b',effect:'trusted-code',risk:'high'};

test('project-tool consent survives target changes and continuations without expanding legacy or high-risk grants', () => {
 const edit = { ...expected, toolId:'component.configure', effect:'reversible-edit', risk:'medium', reusableScopeDigest:'sha256:project-tool' };
 const grant = { ...edit, scope:'project-tool', decision:'allow-always' };
 assert.equal(matchesProjectToolApproval(grant, { ...edit, target:'entity:next', baseRevision:99, argsDigest:'changed', previewDigest:'changed' }), true);
 for (const field of ['taskId','documentId','toolId','toolVersion','effect','risk','reusableScopeDigest'])
   assert.equal(matchesProjectToolApproval(grant, { ...edit, [field]:'changed' }), false, field);
 for (const change of [{scope:'project-session'}, {decision:'allow-once'}, {reusableScopeDigest:null}])
   assert.equal(matchesProjectToolApproval({...grant,...change}, edit), false);
 assert.equal(matchesProjectToolApproval({...grant, ...expected}, expected), false);
 assert.equal(matchesProjectToolApproval({...grant,toolId:'official.write'}, {...edit,toolId:'official.write'}), false);
 assert.equal(matchesRecoveredApproval({...edit,decision:'allow-always',scope:'project-session'}, {...edit,target:'entity:next'}), false);
});
test('recovered consent is task-scoped, exact, and cannot be consumed twice',()=>{
 const grant={...expected,decision:'allow-once'};
 assert.equal(matchesRecoveredApproval(grant,expected),true);
 for(const field of Object.keys(expected))assert.equal(matchesRecoveredApproval(grant,{...expected,[field]:'changed'}),false,field);
 for(const decision of ['pending','reject','cancel'])assert.equal(matchesRecoveredApproval({...grant,decision},expected),false);
 assert.equal(matchesRecoveredApproval({...grant,consumedBy:'call:one'},expected),false);
 assert.equal(matchesRecoveredApproval({...grant,documentId:undefined},expected),false);
});
test('replacement preview handles reuse only the identical validated runtime preview',()=>{
 const runtime={...expected,toolId:'play.start',effect:'runtime-start'};
 const grant={...runtime,decision:'allow-once'};
 assert.equal(matchesRecoveredApproval(grant,{...runtime,argsDigest:'sha256:new-plan-handle'}),true);
 for(const field of ['taskId','documentId','toolId','toolVersion','target','baseRevision','previewDigest','effect','risk'])
   assert.equal(matchesRecoveredApproval(grant,{...runtime,[field]:'changed'}),false,field);
 assert.equal(matchesRecoveredApproval({...grant,consumedBy:'approval:used'},runtime),false);
});
