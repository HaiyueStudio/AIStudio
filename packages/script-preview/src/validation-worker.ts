import { parentPort } from 'node:worker_threads';
import path from 'node:path';
import ts from 'typescript';

interface ValidationRequest {
  readonly id: string;
  readonly sourcePath: string;
  readonly text: string;
  readonly declarations: string;
}

interface ScriptDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

if (!parentPort) throw new Error('Script validation worker requires a parent port.');
parentPort.on('message', (request: ValidationRequest) => {
  try { parentPort!.postMessage(validate(request)); }
  catch (cause) {
    parentPort!.postMessage({ id: request.id, diagnostics: [{
      code: 'script.validator.failed', severity: 'error', path: request.sourcePath, line: 1, column: 1,
      message: cause instanceof Error ? cause.message : String(cause),
    }], emittedText: '', normalizedText: request.text, repairs: [] });
  }
});

function validate(request: ValidationRequest): Readonly<{ id: string; diagnostics: readonly ScriptDiagnostic[]; emittedText: string; normalizedText: string; repairs: readonly string[] }> {
  const normalized = normalizeGeneratedScript(request.text, request.sourcePath);
  const prefix = `${request.declarations}\n`;
  // Resolve injected Engine type imports relative to this package, not the
  // directory from which Electron happened to be launched.
  const virtualPath = path.join(import.meta.dirname, `.haiyue-script-${request.id.replaceAll(':', '-')}.ts`);
  const sourceText = prefix + normalized.text;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
  };
  const normalizedVirtualPath = path.resolve(virtualPath).replaceAll('\\', '/').toLowerCase();
  const isVirtual = (fileName: string): boolean => path.resolve(fileName).replaceAll('\\', '/').toLowerCase() === normalizedVirtualPath;
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => isVirtual(fileName) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => isVirtual(fileName) ? sourceText : ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => isVirtual(fileName)
    ? ts.createSourceFile(fileName, sourceText, languageVersion, true, ts.ScriptKind.TS)
    : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([virtualPath], options, host);
  const prefixLines = prefix.split(/\r?\n/u).length - 1;
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file
      && path.resolve(diagnostic.file.fileName).replaceAll('\\', '/').toLowerCase() === normalizedVirtualPath
      && diagnostic.start !== undefined)
    .map((diagnostic): ScriptDiagnostic => {
      const position = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!);
      return Object.freeze({
        code: `script.ts.${diagnostic.code}`,
        severity: diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
        path: request.sourcePath,
        line: Math.max(1, position.line + 1 - prefixLines),
        column: position.character + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      });
    });
  diagnostics.push(...capabilityDiagnostics(normalized.text, request.sourcePath));
  const transpiled = ts.transpileModule(normalized.text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, removeComments: false },
    fileName: request.sourcePath,
  });
  return Object.freeze({ id: request.id, diagnostics: Object.freeze(diagnostics), emittedText: transpiled.outputText.trim(), normalizedText: normalized.text, repairs: normalized.repairs });
}

function normalizeGeneratedScript(input: string, sourcePath: string): Readonly<{ text: string; repairs: readonly string[] }> {
  let text = input;
  const repairs: string[] = [];
  const fenced = /^```(?:typescript|ts|javascript|js)?\s*\r?\n([\s\S]*?)\r?\n```$/iu.exec(input.trim());
  if (fenced) { text = fenced[1]!.trim(); repairs.push('removed-markdown-fence'); }
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const edits: Array<Readonly<{ start: number; end: number; replacement: string }>> = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && ['@haiyue/engine', '@haiyue/engine/components'].includes(statement.moduleSpecifier.text) && importIsTypeSafeToRemove(statement, source)) {
      edits.push({ start: statement.getFullStart(), end: statement.end, replacement: '' });
      repairs.push('removed-redundant-engine-import');
    }
  }
  const wrappers = source.statements.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement)
    && Boolean(statement.body)
    && ['onUpdate', 'update', 'tick'].includes(statement.name?.text ?? '')
    && (ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false));
  if (wrappers.length === 1) {
    const wrapper = wrappers[0]!;
    for (const modifier of ts.getModifiers(wrapper) ?? []) if (modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) edits.push({ start: modifier.getStart(source), end: modifier.end, replacement: '' });
    const argument = '{ entity, component, world, time, delta, api }';
    edits.push({ start: text.length, end: text.length, replacement: `\n${wrapper.name!.text}(${wrapper.parameters.length > 0 ? argument : ''});` });
    repairs.push('adapted-update-lifecycle-wrapper');
  }
  for (const edit of edits.sort((left, right) => right.start - left.start)) text = `${text.slice(0, edit.start)}${edit.replacement}${text.slice(edit.end)}`;
  return Object.freeze({ text: repairs.length > 0 ? text.trim() : text, repairs: Object.freeze([...new Set(repairs)]) });
}

function importIsTypeSafeToRemove(statement: ts.ImportDeclaration, source: ts.SourceFile): boolean {
  const clause = statement.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return true;
  const names = new Set<string>();
  if (clause.name) names.add(clause.name.text);
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) names.add(element.name.text);
  let unsafe = false;
  const visit = (node: ts.Node): void => {
    if (unsafe || node === statement) return;
    if (ts.isIdentifier(node) && names.has(node.text) && !identifierIsTypeOnly(node)) { unsafe = true; return; }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return !unsafe;
}

function identifierIsTypeOnly(identifier: ts.Identifier): boolean {
  let node: ts.Node = identifier;
  while (node.parent && !ts.isStatement(node.parent)) {
    node = node.parent;
    if (ts.isTypeNode(node)) return true;
  }
  return false;
}

function capabilityDiagnostics(text: string, sourcePath: string): ScriptDiagnostic[] {
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const diagnostics: ScriptDiagnostic[] = [];
  const forbiddenGlobals = new Set([
    'document', 'window', 'globalThis', 'self', 'top', 'parent', 'frames', 'opener',
    'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'customElements',
    'process', 'require', 'module', 'Buffer', '__dirname', '__filename', 'Deno', 'Bun',
    'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel', 'postMessage',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
    'eval', 'Function', 'open', 'Image', 'Audio', 'showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker',
  ]);
  const visit = (node: ts.Node): void => {
    let code: string | null = null;
    let message = '';
    if (isModuleSyntax(node)) {
      code = 'script.capability.module-forbidden'; message = 'Project scripts cannot import or export modules.';
    } else if (ts.isIdentifier(node) && forbiddenGlobals.has(node.text) && !isPropertyName(node)) {
      code = 'script.capability.global-forbidden'; message = `Global ${node.text} is outside the trusted-project capability contract.`;
    }
    if (code) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      diagnostics.push(Object.freeze({ code, severity: 'error', path: sourcePath, line: position.line + 1, column: position.character + 1, message }));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return diagnostics;
}

function isModuleSyntax(node: ts.Node): boolean {
  return ts.isImportDeclaration(node)
    || ts.isImportEqualsDeclaration(node)
    || ts.isExportDeclaration(node)
    || ts.isExportAssignment(node)
    || node.kind === ts.SyntaxKind.ImportKeyword
    || ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isPropertyDeclaration(parent) && parent.name === node);
}
