import path from 'node:path';
import ts from 'typescript';

const orchestration = 'packages/agent-orchestration/';
const packageName = '@haiyue/ai-studio-agent-orchestration';
const allowedImports = new Set([
  '@haiyue/ai-studio-contracts', '@haiyue/ai-studio-agent-runtime',
  '@haiyue/ai-studio-game-authoring-tools', '@haiyue/ai-studio-operation-log',
  '@haiyue/ai-studio-shell/conversation',
  '@haiyue/ai-studio-shell/advanced/model', '@haiyue/ai-studio-shell/resources/model',
]);
const allowedDependencies = new Set([...allowedImports].map((name) => name.split('/').slice(0, 2).join('/')));

export function orchestrationBoundaryViolations(relative, text) {
  const violations = [];
  const fail = (message) => violations.push(`${relative}: ${message}`);
  if (relative.endsWith('/package.json')) {
    const manifest = JSON.parse(text);
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    for (const name of Object.keys(dependencies)) {
      if (relative === `${orchestration}package.json` && !allowedDependencies.has(name)) fail(`orchestration has forbidden production dependency ${name}`);
      if (relative.startsWith('packages/') && name === packageName) fail('lower-level packages must not depend on orchestration');
    }
    return violations;
  }
  if (!/^(?:packages|apps)\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/u.test(relative)) return violations;
  const inOrchestration = relative.startsWith(`${orchestration}src/`);
  const inProjection = relative.startsWith('packages/studio-shell/src/conversation/');
  const inEditorProjection = /^packages\/studio-shell\/src\/panels\/(?:advanced|resources)\/model\.ts$/u.test(relative);
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const specifier of specifiers) {
    const local = specifier.startsWith('.');
    const target = local ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)) : specifier;
    if (inOrchestration && (local ? !target.startsWith(`${orchestration}src/`) : !allowedImports.has(specifier))) fail(`headless orchestration cannot import ${specifier}`);
    if (inProjection && (local ? !target.startsWith('packages/studio-shell/src/conversation/') : specifier !== '@haiyue/ai-studio-contracts')) fail(`headless conversation projections cannot import ${specifier}`);
    if (inEditorProjection && !['@haiyue/ai-studio-contracts', '@haiyue/editor-plugin-sdk'].includes(specifier)) fail(`headless editor projections cannot import ${specifier}`);
    if (relative.startsWith('packages/') && (target.startsWith('apps/') || specifier === '@haiyue/ai-studio' || specifier.startsWith('@haiyue/ai-studio/'))) fail(`packages cannot import app code ${specifier}`);
    if (relative.startsWith('packages/') && !inOrchestration && (target.startsWith(orchestration) || specifier === packageName || specifier.startsWith(`${packageName}/`))) fail(`lower-level packages cannot import orchestration ${specifier}`);
  }
  return violations;
}
