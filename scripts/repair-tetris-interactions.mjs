import { createHash } from 'node:crypto';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ScriptValidationWorker } from '../packages/script-preview/dist/index.js';

const projectPath = process.argv[2];
if (!projectPath || path.basename(projectPath) !== '.haiyue-project.json') throw new Error('Pass the exact .haiyue-project.json path.');

const source = `const W = world as any;
const I = api.input;
const S: any = W.tetris || (W.tetris = {
  board: Array.from({ length: 20 }, () => Array(10).fill(-1)), piece: null, fall: 0, soft: 0,
  score: 0, over: false, seed: 123456789, pointer: { down: false, x: 0, y: 0, lastX: 0, lastY: 0, soft: false }
});
const shapes: number[][][] = [
  [[0,1],[1,1],[2,1],[3,1]], [[0,0],[0,1],[1,1],[2,1]], [[2,0],[0,1],[1,1],[2,1]],
  [[1,0],[2,0],[1,1],[2,1]], [[1,0],[2,0],[0,1],[1,1]], [[1,0],[0,1],[1,1],[2,1]], [[0,0],[1,0],[1,1],[2,1]]
];
function rnd(): number { S.seed = (S.seed * 1664525 + 1013904223) >>> 0; return S.seed / 4294967296; }
function cells(p: any): number[][] {
  return shapes[p.t].map((q: number[]) => {
    let x = q[0] - 1.5, y = q[1] - 1.5;
    for (let i = 0; i < p.r; i++) { const previous = x; x = -y; y = previous; }
    return [Math.round(x + 1.5) + p.x, Math.round(y + 1.5) + p.y];
  });
}
function hit(p: any): boolean {
  return cells(p).some((q: number[]) => q[0] < 0 || q[0] >= 10 || q[1] >= 20 || (q[1] >= 0 && S.board[q[1]][q[0]] >= 0));
}
function spawn(): void {
  S.piece = { t: Math.floor(rnd() * 7), c: Math.floor(rnd() * 2), x: 3, y: -2, r: 0 };
  S.fall = 0; S.soft = 0;
  if (hit(S.piece)) S.over = true;
}
function lock(): void {
  for (const q of cells(S.piece)) if (q[1] >= 0) S.board[q[1]][q[0]] = S.piece.c;
  let cleared = 0;
  for (let y = 19; y >= 0; y--) if (S.board[y].every((value: number) => value >= 0)) {
    S.board.splice(y, 1); S.board.unshift(Array(10).fill(-1)); cleared++; y++;
  }
  S.score += [0, 1, 3, 3, 10][cleared] || 0;
  spawn();
}
function move(dx: number, dy: number, dr: number): boolean {
  const next = { ...S.piece, x: S.piece.x + dx, y: S.piece.y + dy, r: (S.piece.r + dr + 4) % 4 };
  if (hit(next)) return false;
  S.piece = next; return true;
}
function pressed(a: string, b?: string): boolean { return I.wasPressed(a) || (b ? I.wasPressed(b) : false); }
function held(a: string, b?: string): boolean { return I.isPressed(a) || (b ? I.isPressed(b) : false); }
function reset(): void {
  S.board = Array.from({ length: 20 }, () => Array(10).fill(-1));
  S.piece = null; S.fall = 0; S.soft = 0; S.score = 0; S.over = false;
  S.pointer = { down: false, x: 0, y: 0, lastX: 0, lastY: 0, soft: false };
  spawn();
}
if (!S.pointer) S.pointer = { down: false, x: 0, y: 0, lastX: 0, lastY: 0, soft: false };
if (!S.piece) spawn();

const swipe = 0.06;
for (const event of I.pointerEvents()) {
  const x = event.x, y = event.y;
  if (event.type === 'down') {
    S.pointer = { down: true, x, y, lastX: x, lastY: y, soft: false };
  } else if (event.type === 'move' && S.pointer.down) {
    let dx = x - S.pointer.lastX;
    while (dx >= swipe) { if (!S.over) move(1, 0, 0); S.pointer.lastX += swipe; dx = x - S.pointer.lastX; }
    while (dx <= -swipe) { if (!S.over) move(-1, 0, 0); S.pointer.lastX -= swipe; dx = x - S.pointer.lastX; }
    S.pointer.lastY = y;
    S.pointer.soft = y - S.pointer.y >= swipe && Math.abs(y - S.pointer.y) > Math.abs(x - S.pointer.x);
  } else if (event.type === 'up' && S.pointer.down) {
    const totalX = x - S.pointer.x, totalY = y - S.pointer.y;
    if (!S.over) {
      if (Math.abs(totalX) < 0.025 && Math.abs(totalY) < 0.025) move(0, 0, 1);
      else if (totalY <= -swipe && Math.abs(totalY) > Math.abs(totalX)) move(0, 0, 1);
      else if (totalY >= swipe && Math.abs(totalY) > Math.abs(totalX)) {
        const steps = Math.max(1, Math.floor(totalY / swipe));
        for (let i = 0; i < steps; i++) if (!move(0, 1, 0)) { lock(); break; }
      }
    }
    S.pointer.down = false; S.pointer.soft = false;
  } else if (event.type === 'cancel') {
    S.pointer.down = false; S.pointer.soft = false;
  }
}

if (pressed('KeyR')) reset();
if (!S.over) {
  if (pressed('ArrowLeft', 'KeyA')) move(-1, 0, 0);
  if (pressed('ArrowRight', 'KeyD')) move(1, 0, 0);
  if (pressed('ArrowUp', 'KeyW') || pressed('KeyX')) move(0, 0, 1);
  if (pressed('KeyZ')) move(0, 0, -1);
  if (pressed('Space')) { while (move(0, 1, 0)) {} lock(); }
  const softHeld = held('ArrowDown', 'KeyS') || S.pointer.soft;
  if (pressed('ArrowDown', 'KeyS') && !move(0, 1, 0)) lock();
  if (softHeld) {
    S.soft += delta;
    while (S.soft >= 55 && !S.over) { S.soft -= 55; if (!move(0, 1, 0)) { lock(); break; } }
  } else S.soft = 0;
  S.fall += delta;
  const interval = Math.max(100, 650 - S.score * 20);
  while (S.fall >= interval && !S.over) { S.fall -= interval; if (!move(0, 1, 0)) { lock(); break; } }
}

const dropInterval = Math.max(100, 650 - S.score * 20);
api.scene.hudText('tetris-score', 'SCORE  ' + S.score + '\\nDROP   ' + dropInterval + 'ms', { position: 'top-right', color: '#7ffcff', backgroundColor: '#07152ddd', fontSize: 20 });
if (S.over) api.scene.hudText('tetris-game-over', 'GAME OVER\\nPress R to restart', { position: 'center', color: '#ffdd55', backgroundColor: '#1a0822ee', fontSize: 30 });
else api.scene.removeHudText('tetris-game-over');

const groups: any[][] = [[], []];
for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) {
  const color = S.board[y][x];
  if (color >= 0) groups[color].push({ position: { x: x - 4.5, y: 0, z: y - 9.5 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 0.92, y: 0.5, z: 0.92 } });
}
if (!S.over) for (const q of cells(S.piece)) if (q[1] >= 0) groups[S.piece.c].push({ position: { x: q[0] - 4.5, y: 0, z: q[1] - 9.5 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 0.92, y: 0.5, z: 0.92 } });
const cyan = api.scene.instances('entity:2b98555b-fe86-4240-8217-f99130ab6c73', 200);
const yellow = api.scene.instances('entity:5b19b0a3-cdd4-4efb-b68c-008b05189986', 200);
const hidden = { position: { x: 30, y: -5, z: 30 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 0.01, y: 0.01, z: 0.01 } };
for (let i = 0; i < 200; i++) {
  cyan.set(i, i < groups[0].length ? groups[0][i] : hidden);
  yellow.set(i, i < groups[1].length ? groups[1][i] : hidden);
}`;

const validator = new ScriptValidationWorker();
try {
  const validation = await validator.validate({
    scriptId: 'script:tetris-repair', textRevision: 1, sourcePath: 'scripts/tetris-repair.ts', source,
    text: source, capabilities: ['read', 'input', 'scene'],
  });
  const errors = validation.diagnostics.filter((item) => item.severity === 'error');
  if (errors.length) throw new Error(`Repair source failed Studio validation: ${JSON.stringify(errors)}`);
} finally { await validator.dispose(); }

const raw = await readFile(projectPath, 'utf8');
const project = JSON.parse(raw);
const scripts = project?.document?.scripts;
if (!Array.isArray(scripts) || scripts.length !== 1) throw new Error('Expected exactly one Tetris controller script.');
const script = scripts[0];
if (script.entityId !== 'entity:e5802130-86e1-4038-8180-375c0dacb478') throw new Error('The project is not the expected Tetris fixture.');
const backupPath = `${projectPath}.before-interaction-repair`;
await copyFile(projectPath, backupPath);
script.source = source;
script.textRevision = Number(script.textRevision) + 1;
script.capabilities = ['read', 'input', 'scene'];
script.digest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
project.document.revision = Number(project.document.revision) + 1;
project.document.savedRevision = project.document.revision;
const temporaryPath = `${projectPath}.repairing`;
await writeFile(temporaryPath, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
await rename(temporaryPath, projectPath);
console.log(JSON.stringify({ projectPath, backupPath, revision: project.document.revision, textRevision: script.textRevision, digest: script.digest }));
