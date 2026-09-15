import test from 'node:test';
import assert from 'node:assert/strict';
import { detailTextIncluded } from '../dist/panels/chat/detail-text.js';

test('recognizes duplicate failure/cancellation explanations with tool headings and Markdown formatting',()=>{
 const message='acceptance[7]: gesture.interactions.0.type is not an event-trace field.';
 assert.equal(detailTextIncluded(`### studio.plan.propose（失败）\n\n${message}`,`studio.plan.propose: ${message}`),true);
 assert.equal(detailTextIncluded(`**play.start（已取消）**\n\n等待用户确认。`,'play.start: 等待用户确认。'),true);
 assert.equal(detailTextIncluded('成功完成一项操作。\n\n'+message,message),true);
});
test('distinct causes, truncated results and missing explanations stay visible',()=>{
 assert.equal(detailTextIncluded('执行失败。','revision conflict'),false);
 assert.equal(detailTextIncluded('acceptance[7]: gesture…','acceptance[7]: gesture.interactions.0.type'),false);
 assert.equal(detailTextIncluded('field foo_bar invalid','field foobar invalid'),false);
 assert.equal(detailTextIncluded(null,'missing result'),false);
 assert.equal(detailTextIncluded('anything',''),false);
});
