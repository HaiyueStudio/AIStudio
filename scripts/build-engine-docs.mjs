import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { studioScriptRuntimeDeclarations } from '../packages/script-preview/dist/index.js';
import { GAME_AUTHORING_TOOL_DEFINITIONS, EngineDocumentationStore } from '../packages/game-authoring-tools/dist/index.js';
import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins';

const root = path.resolve(import.meta.dirname, '..');
const hash = value => `sha256:${createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;
const docId = key => `doc:${hash(key).slice(7, 31)}`;
const capabilities = ['read', 'scene', 'asset', 'input', 'physics', 'debug'];
const scriptContract = studioScriptRuntimeDeclarations(capabilities);
const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@haiyue/engine'))), '..');
const pkg = JSON.parse(await readFile(path.join(engineRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const enginePin = lock.packages['node_modules/@haiyue/engine'];
const guidesRaw = await readFile(path.join(root, 'vendor/haiyue-engine-reference-docs.json'), 'utf8');
const guidePin = JSON.parse(await readFile(path.join(root, 'config/engine-docs-source.json'), 'utf8'));
if (hash(guidesRaw) !== guidePin.digest || enginePin.integrity !== guidePin.engineIntegrity) throw new Error('Engine reference docs must be reviewed and bound to the installed candidate.');
const upstreamGuides = JSON.parse(guidesRaw);
if (upstreamGuides.contentDigest !== hash(upstreamGuides.entries)) throw new Error('Engine guide content digest mismatch.');
const binding = { engineVersion: pkg.version, engineIntegrity: enginePin.integrity, scriptContractDigest: hash(scriptContract), guidesDigest: hash(guidesRaw) };
const entries = []; const byKey = new Map();
const aliases = [
  [/input|pointer|interaction|raycast/i, '输入 鼠标 拖拽 点击 触摸 射线 拾取 命中 坐标'],
  [/camera|orbit|projection/i, '相机 视角 轨道 透视 正交'],
  [/transform|position|rotation|quaternion|matrix/i, '变换 位置 旋转 缩放 父子 局部 世界 坐标'],
  [/geometry|rounded|box|plane/i, '几何体 圆角 立方体 平面 外观'],
  [/prefab|hierarchy|parent/i, '预制体 组合 层级 复制 部件'],
  [/material|lighting|light|pbr/i, '材质 颜色 灯光 光源 光照 黑色'],
  [/physics|velocity|collision|body/i, '物理 刚体 碰撞 重力 速度'],
  [/asset|texture|model|animation/i, '资源 纹理 模型 动画'],
  [/debug|dispos|listen|timer/i, '调试 清理 生命周期 监听 定时器'],
];
function add(key, title, surface, source, blocks, summary, relatedKeys = [], capabilityIds = []) {
  if (byKey.has(key)) {
    const existing = byKey.get(key);
    for (const block of blocks) if (!existing.blocks.includes(block)) existing.blocks.push(block);
    existing._relatedKeys.push(...relatedKeys); existing.digest = hash(existing.blocks);
    return existing;
  }
  const entry = { id: docId(key), title, surface, source, summary: summary.slice(0, 320) || title, capabilityIds, keywords: aliases.filter(([match]) => match.test(title)).map(([, words]) => words).join(' '), blocks, relatedIds: [], digest: hash(blocks) };
  // Blocks are atomic: never split a declaration or fenced example to meet a token budget.
  if (blocks.some(block => Buffer.byteLength(block) > 24_000)) throw new Error(`Oversized documentation block: ${title}`);
  entries.push(entry); byKey.set(key, entry); entry._relatedKeys = relatedKeys;
  return entry;
}
function markdownBlocks(text) {
  const blocks = []; let block = []; let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!line.trim() && !fence) { if (block.length) blocks.push(block.join('\n')); block = []; }
    else block.push(line);
  }
  if (block.length) blocks.push(block.join('\n'));
  return blocks;
}
function comment(symbol, checker) { return ts.displayPartsToString(symbol.getDocumentationComment(checker)); }
const entryFiles = Object.entries(pkg.exports).map(([subpath, spec]) => [subpath, path.join(engineRoot, spec.types)]);
const program = ts.createProgram(entryFiles.map(([, file]) => file), { skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
const checker = program.getTypeChecker();
for (const [subpath, file] of entryFiles) {
  const module = checker.getSymbolAtLocation(program.getSourceFile(file));
  if (!module) continue;
  const entrypoint = subpath === '.' ? '@haiyue/engine' : `@haiyue/engine/${subpath.slice(2)}`;
  for (const exported of checker.getExportsOfModule(module)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const name = exported.name; const key = `${entrypoint}:${name}`;
    const declarations = symbol.declarations ?? [];
    if (!declarations.length) throw new Error(`Unresolved public export: ${key}`);
    const parentKeys = [];
    for (const declaration of declarations) {
      if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
        for (const member of declaration.members) {
          if (ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword) || (member.name && ts.isPrivateIdentifier(member.name))) continue;
          const memberName = member.name?.getText() ?? (ts.isConstructorDeclaration(member) ? 'constructor' : 'call');
          const memberKey = `${key}.${memberName}`;
          const text = member.getFullText().trim();
          if (byKey.has(memberKey)) { const previous = byKey.get(memberKey); previous.blocks.push('```ts\n' + text + '\n```'); previous.digest = hash(previous.blocks); }
          else add(memberKey, `${name}.${memberName}`, 'engine-native', `declaration:${entrypoint}#${name}`, [`Owner: ${name}. Native Engine API; importing this symbol is not supported in a Studio onUpdate body. Check studio-script or authoring routes first.`, '```ts\n' + text + '\n```'], comment(checker.getSymbolAtLocation(member.name ?? member) ?? symbol, checker) || `${name}.${memberName} public member`, [key]);
          parentKeys.push(memberKey);
        }
        add(key, name, 'engine-native', `declaration:${entrypoint}#${name}`, [`Native Engine entrypoint: ${entrypoint}. ${subpath.includes('experimental') ? 'Experimental; no stability promise.' : 'Public export.'} Studio script availability is separate.`, comment(symbol, checker) || name, `Public members: ${parentKeys.map(key => key.slice(key.lastIndexOf(':') + 1)).join(', ') || '(none)'}`, ...(declaration.heritageClauses?.map(clause => clause.getText()) ?? [])], comment(symbol, checker) || `Public ${name} from ${entrypoint}`, parentKeys.slice(0, 128));
      } else {
        add(key, name, 'engine-native', `declaration:${entrypoint}#${name}`, [`Native Engine entrypoint: ${entrypoint}. Studio script availability is separate.`, '```ts\n' + declaration.getFullText().trim() + '\n```'], comment(symbol, checker) || `Public ${name} from ${entrypoint}`);
      }
    }
  }
}
// Instance members reachable through injected values are usable without importing constructors.
for (const name of ['Entity', 'Component', 'System', 'World']) {
  const owner = byKey.get(`@haiyue/engine:${name}`);
  if (!owner) continue;
  const copies = [];
  for (const memberKey of owner._relatedKeys) {
    const member = byKey.get(memberKey);
    if (!member || /\.constructor$/.test(member.title) || member.blocks.some(block => /\bstatic\b/.test(block))) continue;
    const key = `script-instance:${member.title}`;
    add(key, member.title, 'studio-script', `studio-instance:${name}`, [`Instance member reachable through injected entity/component/world or api.read results; this does not expose a constructor or permit imports.`, ...member.blocks.slice(1)], member.summary, [`script-instance:${name}`]);
    copies.push(key);
  }
  add(`script-instance:${name}`, name, 'studio-script', `studio-instance:${name}`, [`Injected/reachable ${name} instance. Do not construct or import it.`, ...owner.blocks.slice(1)], `Instance members of ${name} in Studio scripts`, copies);
}
// Parse exactly the declarations used by the Studio compiler, including interface merges.
const scriptSource = ts.createSourceFile('studio-runtime.d.ts', scriptContract, ts.ScriptTarget.ES2022, true);
const interfaceKeys = new Map();
for (const statement of scriptSource.statements) {
  if (!ts.isInterfaceDeclaration(statement)) continue;
  const apiGroup = /^HaiyueScript(\w+)Api$/.exec(statement.name.text)?.[1]?.toLowerCase();
  for (const member of statement.members) {
    const name = member.name?.getText(scriptSource); if (!name) continue;
    const title = apiGroup ? `api.${apiGroup}.${name}` : `${statement.name.text}.${name}`;
    const key = `script:${title}`;
    const text = member.getFullText(scriptSource).trim();
    add(key, title, 'studio-script', `studio-runtime:${statement.name.text}`, [`Studio onUpdate API. ${apiGroup && capabilities.includes(apiGroup) ? `Requires capability: ${apiGroup}.` : 'Related runtime type.'} time/delta are milliseconds; persistent state belongs to component.data.`, '```ts\n' + text + '\n```'], text.replace(/\s+/g, ' ').slice(0, 250), apiGroup === 'input' ? ['guide:input-actions', 'component:haiyue.interaction.pointer', 'example:grid-placement'] : apiGroup === 'scene' ? ['guide:composite-object-authoring'] : [], apiGroup && capabilities.includes(apiGroup) ? [apiGroup] : []);
    const keys = interfaceKeys.get(statement.name.text) ?? []; keys.push(key); interfaceKeys.set(statement.name.text, keys);
  }
}
for (const [name, keys] of interfaceKeys) add(`script-type:${name}`, name, 'studio-script', `studio-runtime:${name}`, [`Runtime type ${name}`, ...scriptSource.statements.filter(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === name).map(statement => '```ts\n' + statement.getFullText(scriptSource).trim() + '\n```')], `Complete Studio type ${name}`, keys.slice(0, 128));
for (const entry of entries.filter(entry => entry.surface === 'studio-script')) {
  for (const name of interfaceKeys.keys()) if (entry.blocks.some(block => block.includes(name))) entry._relatedKeys.push(`script-type:${name}`);
}
for (const tool of GAME_AUTHORING_TOOL_DEFINITIONS) add(`tool:${tool.id}`, tool.id, 'authoring', `tool:${tool.id}@${tool.version}`, [tool.description, '```json\n' + JSON.stringify(tool.inputSchema, null, 2) + '\n```'], tool.description);
for (const component of new ComponentRegistry().snapshot().definitions) add(`component:${component.type}`, component.type, 'authoring', `component:${component.type}@${component.version}`, [`${component.editor.label}. Configure using component.configure; Play adapter: ${component.runtimeAdapter}.`, '```json\n' + JSON.stringify({ valueSchema: component.valueSchema, defaults: component.defaults }, null, 2) + '\n```'], `${component.editor.label} ${component.capability}`);
for (const guide of JSON.parse(await readFile(path.join(root, 'packages/game-authoring-tools/docs/guides.json'), 'utf8'))) add(`guide:${guide.id}`, guide.title, 'authoring', `studio-guide:${guide.id}`, [guide.text], guide.text, ['tool:component.describe', 'tool:tool.search'], guide.capabilityIds);
for (const guide of upstreamGuides.entries) add(`guide-native:${guide.path}`, guide.text.split('\n').find(line => line.startsWith('# '))?.slice(2) ?? guide.path, 'engine-native', `engine-guide:${upstreamGuides.sourceRevision}/${guide.path}`, markdownBlocks(guide.text), `Native Engine reference from ${guide.path}; examples require the native integration environment.`);
add('guide:textured-grid-alignment', '贴图网格与交互落点对齐 / Textured grid alignment', 'authoring', 'studio-reference:textured-grid-alignment', markdownBlocks(await readFile(path.join(root, 'docs/architecture/textured-grid-alignment.md'), 'utf8')), '棋盘纹理像素、交点数量、UV 与逻辑网格统一，避免落子偏移。', ['example:grid-placement', 'tool:asset.generate-texture', 'script:api.input.interactions']);
add('example:grid-placement', '棋盘命中点吸附 / grid placement with engine picking', 'studio-script', 'studio-example:grid-placement', ['Prerequisites: entity:board has haiyue.interaction.pointer events [click]; entity:marker supplies an instanced mesh. Axis-aligned XZ board with shared world origin/spacing. Rotated or parent-transformed boards need world-to-board conversion before snapping. Capabilities: input, scene.', '```ts\n' + await readFile(path.join(root, 'docs/examples/grid-placement.ts'), 'utf8') + '\n```'], '点击棋盘 使用引擎拾取命中点吸附到格子，无屏幕到世界的固定比例。', ['script:api.input.interactions', 'component:haiyue.interaction.pointer', 'guide:input-actions', 'guide:textured-grid-alignment']);
add('example:rotate-self', '自身旋转 / rotate entity transform', 'studio-script', 'studio-example:rotate-self', ['Prerequisite: entity has CartesianTransform3D. Runtime rotation is parent-local radians; authoring transform tools use rotationDegrees. delta is milliseconds. This updates the actual Engine transform.', '```ts\n' + await readFile(path.join(root, 'docs/examples/rotate-self.ts'), 'utf8') + '\n```'], '旋转自身的真实变换，弧度与角度转换，固定步长毫秒。', ['script-instance:Entity.getComponent', 'tool:transform.set']);
add('example:data-first-verification', '数据优先验收 / 按对象检查与视觉截图分工', 'studio-script', 'studio-example:data-first-verification', [await readFile(path.join(root, 'docs/examples/data-first-verification.md'), 'utf8')], '验收 测试 引擎数据 按对象 截图 多模态 verification inspect capture', ['tool:play.inspect', 'tool:play.pointer-gesture', 'tool:play.capture', 'tool:task.evaluate']);
add('example:click-material-color', '增量对象交互 / 点击随机改色与脚本归属', 'studio-script', 'studio-example:click-material-color', ['Keep camera control on its existing owner; bind local click behavior to the target object and configure its pointer component. selfInteractions selects only the script owner; interactions is global for explicitly designed controllers. setMaterialColor updates actual renderer material; editor material descriptors are not runtime material instances. Verify materialColor from play.inspect and retain existing orbit behavior.', '```ts\n' + await readFile(path.join(root, 'docs/examples/click-material-color.ts'), 'utf8') + '\n```'], '点击 随机 改色 材质 增量 脚本绑定 selfInteractions setMaterialColor', ['script:api.input.selfInteractions', 'script:api.scene.setMaterialColor', 'tool:script.propose', 'tool:play.inspect']);
add('example:orbit-camera', '运行时 OrbitControls / 拖拽相机与背景手势', 'studio-script', 'studio-example:orbit-camera', ['Use api.scene.orbitControls each onUpdate tick from one controller script. mode all handles a simple cube viewer; mode background excludes registered object down hits for games. Built on Engine SphericalTransform3D with the fixed-tick native/replay input pipeline. The browser OrbitControl constructor is not exposed. Disable camera.follow and use a root 3D gameplay camera or the persisted project camera. Configure lights for PBR separately. Compare play.inspect state.camera and unchanged object transforms after play.pointer-gesture; camera.author does not implement runtime input.', '```ts\n' + await readFile(path.join(root, 'docs/examples/orbit-camera.ts'), 'utf8') + '\n```'], 'OrbitControls 运行时相机 拖拽屏幕 鼠标旋转 滚轮缩放 all background 单一手势归属', ['script:api.scene.orbitControls', 'tool:camera.set', 'component:haiyue.interaction.pointer', 'tool:play.pointer-gesture']);
add('contract:studio-runtime', 'Studio 脚本入口 / onUpdate runtime contract', 'studio-script', 'studio-contract:onUpdate', ['Write a strict TypeScript onUpdate function body, without imports, exports or a lifecycle wrapper. Injected values: entity, component, world, time, delta, api. time/delta are milliseconds. Local variables reset each invocation; component.data is persistent state. api groups depend on enabled capabilities; request required capabilities through script.propose and use validation diagnostics.', 'Use api.debug listeners/timers/disposers for lifecycle cleanup. Engine native constructors and editor OrbitControl are not automatically available in Play. For runtime drag/wheel camera control use api.scene.orbitControls; see the orbit-camera example. Discover and configure authoring components before consuming their runtime results. Match the current documentation surface and consult related types.'], '脚本入口、持久状态、时间单位、生命周期、capability 与编辑器/Play 边界', ['example:grid-placement', 'example:rotate-self', 'tool:script.propose']);
const nativeTypes = new Map();
for (const entry of entries.filter(entry => entry.surface === 'engine-native' && entry.source.startsWith('declaration:') && !entry.title.includes('.')).sort((a, b) => a.source.length - b.source.length)) if (!nativeTypes.has(entry.title)) nativeTypes.set(entry.title, entry.id);
for (const entry of entries) { entry.relatedIds = [...new Set(entry._relatedKeys.flatMap(key => byKey.has(key) ? [byKey.get(key).id] : []))].filter(id => id !== entry.id).slice(0, 128); for (const match of entry.blocks.join('\n').matchAll(/engine-reference:\/(docs\/[^)#\s]+)(?:#[^)]*)?/g)) {
    const related = byKey.get(`guide-native:${match[1]}`); if (related && related.id !== entry.id && !entry.relatedIds.includes(related.id) && entry.relatedIds.length < 128) entry.relatedIds.push(related.id);
  }
  if (entry.surface === 'engine-native') for (const symbol of new Set(entry.blocks.join('\n').match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? [])) {
    const id = nativeTypes.get(symbol); if (id && id !== entry.id && !entry.relatedIds.includes(id) && entry.relatedIds.length < 128) entry.relatedIds.push(id);
  }
  delete entry._relatedKeys; }
entries.sort((a, b) => a.id.localeCompare(b.id));
const bundle = { schemaVersion: 1, binding, entries, digest: hash({ binding, entries }) };
const verified = new EngineDocumentationStore(bundle, binding);
for (const entry of entries) {
  let cursor;
  do { const page = verified.read({ id: entry.id, bundleDigest: bundle.digest, maxBytes: 32768, ...(cursor ? { cursor } : {}) }); cursor = page.nextCursor; } while (cursor);
}
const output = path.join(root, 'packages/game-authoring-tools/dist/engine-docs');
if (process.argv.includes('--check')) {
  if (await readFile(path.join(output, 'bundle.json'), 'utf8') !== JSON.stringify(bundle) || await readFile(path.join(output, 'binding.json'), 'utf8') !== JSON.stringify(binding)) throw new Error('Engine documentation is stale; rebuild game-authoring-tools.');
} else {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'bundle.json'), JSON.stringify(bundle));
  await writeFile(path.join(output, 'binding.json'), JSON.stringify(binding));
}
console.log(JSON.stringify({ documents: entries.length, bytes: Buffer.byteLength(JSON.stringify(bundle)), digest: bundle.digest, surfaces: Object.fromEntries(['studio-script', 'authoring', 'engine-native'].map(surface => [surface, entries.filter(entry => entry.surface === surface).length])) }));
