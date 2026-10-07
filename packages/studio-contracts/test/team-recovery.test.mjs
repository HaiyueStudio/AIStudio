import test from 'node:test';import assert from 'node:assert/strict';import {isTeamSessionFrameV1} from '../dist/index.js';
const frame={schemaVersion:1,sessionId:'session:team',header:{version:4},inheritedEventCount:0,offset:0,events:[]};
test('Team frames validate their version and bounded structural envelope',()=>{assert.equal(isTeamSessionFrameV1(frame),true);for(const value of [null,{}, {...frame,schemaVersion:2},{...frame,offset:-1},{...frame,inheritedEventCount:NaN},{...frame,events:[null]},{...frame,extra:'unknown'}])assert.equal(isTeamSessionFrameV1(value),false);});
