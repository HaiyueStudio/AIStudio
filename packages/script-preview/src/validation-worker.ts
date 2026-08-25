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
    }], emittedText: '' });
  }
});

function validate(request: ValidationRequest): Readonly<{ id: string; diagnostics: readonly ScriptDiagnostic[]; emittedText: string }> {
  const prefix = `${request.declarations}\n`;
  const virtualPath = path.join(process.cwd(), `.haiyue-script-${request.id.replaceAll(':', '-')}.ts`);
  const sourceText = prefix + request.text;
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
  diagnostics.push(...capabilityDiagnostics(request.text, request.sourcePath));
  const transpiled = ts.transpileModule(request.text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, removeComments: false },
    fileName: request.sourcePath,
  });
  return Object.freeze({ id: request.id, diagnostics: Object.freeze(diagnostics), emittedText: transpiled.outputText.trim() });
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
