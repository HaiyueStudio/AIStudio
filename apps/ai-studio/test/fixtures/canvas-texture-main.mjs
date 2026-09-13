import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { ProjectWorkspace, RecentProjectStore, ProjectSceneAuthoringService } from '@haiyue/ai-studio-editor-plugins';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { StudioIpcRouter } from '../../dist/ipc.js';
import { app, BrowserWindow, nativeImage } from 'electron';
import { renderCanvasTexture } from '../../dist/canvas-texture-renderer.js';

app.setPath('userData', process.env.HAIYUE_CANVAS_USER_DATA);
app.on('window-all-closed', () => {});
let stage = 'app-ready';
const timeout = setTimeout(() => { console.error(`Canvas timeout: ${stage}`); app.exit(1); }, 30000);
app.whenReady().then(async () => {
try {
  stage = 'draw';
  const baseline = BrowserWindow.getAllWindows().length;
  const bytes = await renderCanvasTexture({ schemaVersion: 1, width: 256, height: 256, background: '#eedd99', commands: [
    { type: 'rect', x: 8, y: 8, width: 240, height: 240, stroke: '#222222', lineWidth: 4 },
    { type: 'line', points: [[8, 128], [248, 128]], stroke: '#222222', lineWidth: 2 },
    { type: 'circle', x: 128, y: 128, radius: 64, fill: '#ffdd99', stroke: '#cc0000', lineWidth: 4 },
    { type: 'text', x: 128, y: 128, text: '将', fontSize: 72, fill: '#cc0000', fontFamily: 'serif', fontWeight: 'bold' },
    { type: 'polygon', points: [[20, 200], [40, 200], [30, 220]], fill: '#0000ff' },
  ] }, new AbortController().signal);
  assert.equal(BrowserWindow.getAllWindows().length, baseline);
  const png = nativeImage.createFromBuffer(Buffer.from(bytes)); assert.deepEqual(png.getSize(), { width: 256, height: 256 });
  const pixels = png.toBitmap();
  const color = (x, y) => [...pixels.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
  assert.deepEqual(color(0, 0), [153, 221, 238, 255]);
  assert.deepEqual(color(8, 20), [34, 34, 34, 255]);
  assert.deepEqual(color(30, 205), [255, 0, 0, 255]);
  let redTextPixels = 0;
  for (let y = 92; y < 164; y++) for (let x = 92; x < 164; x++) { const [b, g, r] = color(x, y); if (r > 150 && g < 60 && b < 60) redTextPixels++; }
  assert.ok(redTextPixels > 150, `Chinese glyph missing: ${redTextPixels}`);
  stage = 'draft-board';
  const grid = await renderCanvasTexture({ schemaVersion: 1, width: 256, height: 256, background: '#eedd99', commands: Array.from({ length: 15 }, (_, i) => 16 + i * 16).flatMap(p => [
    { type: 'line', points: [[16, p], [240, p]], stroke: '#222222', lineWidth: 2 },
    { type: 'line', points: [[p, 16], [p, 240]], stroke: '#222222', lineWidth: 2 },
  ]) }, new AbortController().signal);
  const root = process.env.HAIYUE_CANVAS_USER_DATA;
  const log = await OperationLog.open({ rootDirectory: path.join(root, 'log'), appVersion: 'test' });
  const workspace = new ProjectWorkspace({ documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog: log, recentProjects: new RecentProjectStore(root) });
  const scene = new ProjectSceneAuthoringService(workspace, log);
  try {
    await workspace.newProject(null, 'Draft grid');
    const { asset } = await workspace.importGeneratedTexture({ id: 'command:grid', documentId: workspace.snapshot().document.documentId, baseRevision: 1, bytes: grid, width: 256, height: 256, recipeDigest: 'sha256:' + '0'.repeat(64) });
    assert.equal(workspace.snapshot().projectRoot, null);
    const router = new StudioIpcRouter({ workspace, scene, operationLog: log });
    const response = await router.handle({ schemaVersion: 1, id: 'request:draft-grid', correlationId: 'correlation:draft-grid', channel: 'asset/read', payload: { assetId: asset.id } });
    assert.equal(response.ok, true, JSON.stringify(response));
    const transferred = Buffer.from(response.payload.base64, 'base64');
    assert.deepEqual(transferred, Buffer.from(grid));
    const bitmap = nativeImage.createFromBuffer(transferred).toBitmap();
    const pixel = (x, y) => [...bitmap.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
    assert.deepEqual(pixel(16, 24), [34, 34, 34, 255]); assert.deepEqual(pixel(24, 24), [153, 221, 238, 255]);
    const project = path.join(root, 'saved'); await mkdir(project);
    await workspace.saveAs(project); await workspace.reopen();
    assert.deepEqual(Buffer.from(await workspace.readControlledAsset(asset.projectPath, grid.byteLength)), transferred);
    assert.deepEqual(await readFile(path.join(project, asset.projectPath)), transferred);
    await writeFile(path.join(path.dirname(process.env.HAIYUE_CANVAS_PNG), 'draft-grid.png'), grid);
    console.log('Draft grid PNG generated, read through controlled IPC before save, and preserved after save/reopen.');
  } finally { scene.dispose(); await workspace.dispose(); await log.close(); }
  stage = 'transparent';
  const transparent = await renderCanvasTexture({ schemaVersion: 1, width: 2, height: 2, commands: [] }, new AbortController().signal);
  assert.ok(nativeImage.createFromBuffer(Buffer.from(transparent)).toBitmap().every(v => v === 0));
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(renderCanvasTexture({ schemaVersion: 1, width: 2, height: 2, commands: [] }, aborted.signal));
  stage = 'abort-active';
  const active = new AbortController(); const pending = renderCanvasTexture({ schemaVersion: 1, width: 2, height: 2, commands: [] }, active.signal); active.abort(); await assert.rejects(pending);
  assert.equal(BrowserWindow.getAllWindows().length, baseline);
  await writeFile(process.env.HAIYUE_CANVAS_PNG, bytes);
  console.log('Canvas PNG pixels, Chinese text, alpha, cancellation and window cleanup passed.');
  clearTimeout(timeout); app.exit(0);
} catch (error) { console.error(stage, error); clearTimeout(timeout); app.exit(1); }

});
