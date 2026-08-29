import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const projectPath = process.argv[2];
if (!projectPath || path.basename(projectPath) !== '.haiyue-project.json') throw new Error('Pass the exact .haiyue-project.json path.');
const project = JSON.parse(await readFile(projectPath, 'utf8'));
const script = project?.document?.scripts?.[0];
if (!script || typeof script.source !== 'string') throw new Error('Tetris controller script is missing.');
const emitted = ts.transpileModule(script.source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const execute = new Function('entity', 'component', 'world', 'time', 'delta', 'event', 'api', emitted);

const world = {};
const down = new Set();
const pressed = new Set();
let pointerEvents = [];
const hud = new Map();
const instances = new Map();
const api = {
  input: {
    isPressed: (key) => down.has(key), isDown: (key) => down.has(key),
    wasPressed: (key) => pressed.has(key), wasReleased: () => false,
    pointerEvents: () => pointerEvents, events: () => pointerEvents.map((item) => ({ kind: 'pointer', phase: item.type, ...item })),
  },
  scene: {
    hudText: (id, text, options = {}) => hud.set(id, { text, options }), removeHudText: (id) => hud.delete(id),
    instances: (id, capacity) => {
      const previous = instances.get(id);
      if (previous) { assert.equal(previous.capacity, capacity); return previous; }
      const value = { capacity, values: new Map(), set(index, transform) { this.values.set(index, transform); }, setCount() {} };
      instances.set(id, value); return value;
    },
  },
};
let time = 0;
function tick(delta = 16, options = {}) {
  down.clear(); pressed.clear(); pointerEvents = options.pointerEvents ?? [];
  for (const key of options.down ?? []) down.add(key);
  for (const key of options.pressed ?? []) pressed.add(key);
  time += delta;
  execute({}, {}, world, time, delta, 'update', api);
}

tick();
const state = world.tetris;
assert.ok(state?.piece, 'piece must spawn');
const naturalStart = state.piece.y;
for (let index = 0; index < 45; index++) tick(16);
assert.ok(state.piece.y > naturalStart, 'piece must fall naturally');

state.piece = { t: 0, c: 0, x: 3, y: 5, r: 0 }; state.fall = 0;
for (let index = 0; index < 4; index++) tick(55, { down: ['ArrowDown'] });
assert.ok(state.piece.y >= 9, 'held ArrowDown must repeatedly soft-drop');
state.piece = { t: 0, c: 0, x: 3, y: 5, r: 0 }; state.fall = 0;
for (let index = 0; index < 4; index++) tick(55, { down: ['KeyS'] });
assert.ok(state.piece.y >= 9, 'held S must repeatedly soft-drop');

state.piece = { t: 0, c: 0, x: 3, y: 5, r: 0 }; state.fall = 0;
tick(16, { pointerEvents: [{ type: 'down', pointerId: 1, x: 0.4, y: 0.5 }] });
tick(16, { pointerEvents: [{ type: 'move', pointerId: 1, x: 0.62, y: 0.5 }] });
assert.ok(state.piece.x > 3, 'right swipe must move the piece');
tick(16, { pointerEvents: [{ type: 'up', pointerId: 1, x: 0.62, y: 0.5 }] });

state.piece = { t: 0, c: 0, x: 5, y: 5, r: 0 }; state.fall = 0;
tick(16, { pointerEvents: [{ type: 'down', pointerId: 4, x: 0.65, y: 0.5 }] });
tick(16, { pointerEvents: [{ type: 'move', pointerId: 4, x: 0.43, y: 0.5 }] });
assert.ok(state.piece.x < 5, 'left swipe must move the piece');
tick(16, { pointerEvents: [{ type: 'up', pointerId: 4, x: 0.43, y: 0.5 }] });

state.piece = { t: 0, c: 0, x: 3, y: 5, r: 0 }; state.fall = 0;
tick(16, { pointerEvents: [{ type: 'down', pointerId: 5, x: 0.5, y: 0.5 }] });
tick(16, { pointerEvents: [{ type: 'up', pointerId: 5, x: 0.5, y: 0.5 }] });
assert.equal(state.piece.r, 1, 'pointer click/tap must rotate the piece');

state.piece = { t: 0, c: 0, x: 3, y: 5, r: 0 }; state.fall = 0;
tick(16, { pointerEvents: [{ type: 'down', pointerId: 2, x: 0.5, y: 0.6 }] });
tick(16, { pointerEvents: [{ type: 'up', pointerId: 2, x: 0.5, y: 0.35 }] });
assert.equal(state.piece.r, 1, 'up swipe must rotate the piece');

state.piece = { t: 0, c: 0, x: 3, y: 5, r: 0 }; state.fall = 0;
tick(16, { pointerEvents: [{ type: 'down', pointerId: 3, x: 0.5, y: 0.3 }] });
tick(16, { pointerEvents: [{ type: 'up', pointerId: 3, x: 0.5, y: 0.62 }] });
assert.ok(state.piece.y >= 10, 'down swipe must accelerate the piece');

for (const [lineCount, expectedScore] of [[1, 1], [2, 3], [3, 3], [4, 10]]) {
  state.board = Array.from({ length: 20 }, () => Array(10).fill(-1));
  for (let row = 20 - lineCount; row < 20; row++) for (let column = 0; column < 9; column++) state.board[row][column] = 0;
  state.piece = { t: 0, c: 1, x: 7, y: 16, r: 1 }; state.score = 0; state.fall = 650; state.over = false;
  tick(16);
  assert.equal(state.score, expectedScore, `${lineCount}-line clear must score ${expectedScore}`);
}
assert.match(hud.get('tetris-score')?.text ?? '', /SCORE\s+10/);
assert.match(hud.get('tetris-score')?.text ?? '', /DROP\s+450ms/);
state.score = 100; state.fall = 0; tick(16);
assert.match(hud.get('tetris-score')?.text ?? '', /DROP\s+100ms/, 'drop interval must clamp at 100ms');

tick(16, { pressed: ['KeyR'] });
assert.equal(state.score, 0, 'R must reset score at any time');
assert.equal(state.fall, 16, 'R must reset the fall timer before the current tick advances');
assert.ok(state.board.every((row) => row.every((value) => value === -1)), 'R must clear the board');
assert.match(hud.get('tetris-score')?.text ?? '', /SCORE\s+0/);

console.log(JSON.stringify({
  naturalFall: true, heldArrowDown: true, heldS: true, pointerClick: true, pointerSwipe: true,
  score: state.score, hud: hud.get('tetris-score'), reset: true,
}));
