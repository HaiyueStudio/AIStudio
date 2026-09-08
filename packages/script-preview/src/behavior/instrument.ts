import ts from 'typescript';
import type { BehaviorManifestV1, BehaviorNodeV1, GameDocumentV2 } from '@haiyue/ai-studio-contracts';
import { createBehaviorSourceBinding, prepareBehaviorInput } from './binding.js';
import { BehaviorContractError, freezeProjection } from './canonical.js';
import { parseBehaviorContract } from './validation.js';

/** Derived executable text is only admitted after the existing preview plan's exact
 * emittedText has been checked. It is never written to the project or its History. */
export interface BehaviorScriptProgram {
  readonly scriptId: string;
  readonly sourceDigest: string;
  readonly originalEmittedText: string;
  readonly instrumentedText: string;
  readonly callbackName: string;
  readonly entryNodeId: string | null;
  readonly instrumentedNodeIds: readonly string[];
}
export function instrumentBehaviorScripts(input: unknown, manifestInput: unknown): readonly BehaviorScriptProgram[] {
  const source = prepareBehaviorInput(input), manifest = parseBehaviorContract('behavior-manifest', manifestInput);
  if (createBehaviorSourceBinding(source).digest !== manifest.binding.digest) throw new BehaviorContractError('behavior.stale');
  return freezeProjection(source.document.scripts.filter(script => script.enabled).map(script => instrument(script, manifest)));
}

function instrument(script: GameDocumentV2['scripts'][number], manifest: BehaviorManifestV1): BehaviorScriptProgram {
  const nodes = manifest.nodes.filter(node => node.source.kind === 'script' && node.source.scriptId === script.id);
  const byRange = new Map<string, BehaviorNodeV1[]>();
  for (const node of nodes) {
    if (node.source.kind !== 'script') continue;
    const key = `${node.source.range.start}:${node.source.range.end}`;
    byRange.set(key, [...(byRange.get(key) ?? []), node]);
  }
  let callbackName = `__haiyueBehavior_${manifest.digest.slice(7, 23)}`;
  while (script.source.includes(callbackName)) callbackName += '_';
  const observed = new Set<string>();
  const options: ts.TranspileOptions = { fileName: script.sourcePath, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, removeComments: false } };
  const originalEmittedText = ts.transpileModule(script.source, options).outputText.trim();
  const instrumentedText = ts.transpileModule(script.source, { ...options, transformers: { before: [context => {
    const factory = context.factory;
    let file: ts.SourceFile;
    const matches = (node: ts.Node, kind: string, label?: string) => {
      const candidates = (byRange.get(`${node.getStart(file)}:${node.getEnd()}`) ?? []).filter(item => item.kind === kind && (!label || item.label === label));
      // Static finally paths can duplicate a source range. Without completion
      // context an observation cannot choose one of those nodes truthfully.
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    const call = (method: string, id: string, args: readonly ts.Expression[] = []) => {
      observed.add(id);
      return factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier(callbackName), method), undefined, [factory.createStringLiteral(id), ...args]);
    };
    const around = (id: string, value: ts.Expression): ts.Expression => factory.createParenthesizedExpression(factory.createCommaListExpression([call('enter', id), call('exit', id, [value])]));
    // A call/binary expression may also be the condition of an if/loop. Record
    // the resulting condition after the expression, without evaluating it twice.
    const withCondition = (node: ts.Node, value: ts.Expression): ts.Expression => {
      const condition = matches(node, 'condition');
      return condition ? call('value', condition.id, [value]) : value;
    };
    const prepend = (body: ts.Block, marker: ts.Statement) => {
      // Preserve directive prologues (including strict mode) and lexical declarations.
      let index = 0;
      while (index < body.statements.length && ts.isExpressionStatement(body.statements[index]) && ts.isStringLiteral((body.statements[index] as ts.ExpressionStatement).expression)) index++;
      return factory.updateBlock(body, [...body.statements.slice(0, index), marker, ...body.statements.slice(index)]);
    };
    const visit: ts.Visitor = node => {
      const visited = ts.visitEachChild(node, visit, context);
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        const entry = matches(node, 'entry', 'function-entry');
        if (entry && 'body' in visited && visited.body) {
          const body = visited.body as ts.ConciseBody;
          const next = ts.isBlock(body) ? prepend(body, factory.createExpressionStatement(call('enter', entry.id))) : around(entry.id, body);
          if (ts.isFunctionDeclaration(visited)) return factory.updateFunctionDeclaration(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.typeParameters, visited.parameters, visited.type, next as ts.Block);
          if (ts.isFunctionExpression(visited)) return factory.updateFunctionExpression(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.typeParameters, visited.parameters, visited.type, next as ts.Block);
          if (ts.isArrowFunction(visited)) return factory.updateArrowFunction(visited, visited.modifiers, visited.typeParameters, visited.parameters, visited.type, visited.equalsGreaterThanToken, next);
          if (ts.isMethodDeclaration(visited)) return factory.updateMethodDeclaration(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.questionToken, visited.typeParameters, visited.parameters, visited.type, next as ts.Block);
          if (ts.isGetAccessorDeclaration(visited)) return factory.updateGetAccessorDeclaration(visited, visited.modifiers, visited.name, visited.parameters, visited.type, next as ts.Block);
          if (ts.isSetAccessorDeclaration(visited)) return factory.updateSetAccessorDeclaration(visited, visited.modifiers, visited.name, visited.parameters, next as ts.Block);
        }
        return visited;
      }
      if (ts.isVariableDeclaration(node) && ts.isVariableDeclaration(visited) && visited.initializer) {
        const binding = matches(node, 'statement', 'binding');
        return binding ? factory.updateVariableDeclaration(visited, visited.name, visited.exclamationToken, visited.type, call('value', binding.id, [visited.initializer])) : visited;
      }
      if (ts.isForStatement(node) && ts.isForStatement(visited)) {
        const target = matches(node, 'loop');
        if (target) return factory.updateForStatement(visited, visited.initializer, call('value', target.id, [visited.condition ?? factory.createTrue()]), visited.incrementor, visited.statement);
      }
      if (ts.isWhileStatement(node) && ts.isWhileStatement(visited)) {
        const target = matches(node, 'loop');
        if (target) return factory.updateWhileStatement(visited, call('value', target.id, [visited.expression]), visited.statement);
      }
      if (ts.isDoStatement(node) && ts.isDoStatement(visited)) {
        const target = matches(node, 'loop');
        if (target) return factory.updateDoStatement(visited, visited.statement, call('value', target.id, [visited.expression]));
      }
      // Instrument complete expressions, never an assignment target or a method
      // receiver. An optional call is not claimed as an invocation when skipped.
      if (ts.isCallExpression(node) && !ts.isCallChain(node) && ts.isCallExpression(visited)) {
        const target = matches(node, 'call'); if (target) return withCondition(node, around(target.id, visited));
      }
      if (ts.isAwaitExpression(node) && ts.isAwaitExpression(visited)) {
        const target = matches(node, 'await'); if (target) return withCondition(node, around(target.id, visited));
      }
      if (ts.isBinaryExpression(node) && ts.isBinaryExpression(visited)) {
        const target = matches(node, 'statement', 'binary-operation'); if (target) return withCondition(node, around(target.id, visited));
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isExpression(visited)) {
        const target = matches(node, 'statement', 'unary-operation'); if (target) return withCondition(node, around(target.id, visited));
      }
      if (ts.isReturnStatement(node) && ts.isReturnStatement(visited)) {
        const target = matches(node, 'return');
        if (target) return factory.updateReturnStatement(visited, call('value', target.id, [visited.expression ?? factory.createVoidZero()]));
      }
      if (ts.isThrowStatement(node) && ts.isThrowStatement(visited)) {
        const target = matches(node, 'throw');
        if (target) return factory.updateThrowStatement(visited, call('value', target.id, [visited.expression]));
      }
      if (ts.isExpression(visited)) return withCondition(node, visited);
      return visited;
    };
    return sourceFile => { file = sourceFile; return ts.visitNode(sourceFile, visit) as ts.SourceFile; };
  }] } }).outputText.trim();
  if (instrumentedText.length > 2 * 1024 * 1024) throw new BehaviorContractError('behavior.instrumentation-budget');
  return { scriptId: script.id, sourceDigest: script.digest, originalEmittedText, instrumentedText, callbackName, entryNodeId: nodes.find(node => node.kind === 'entry' && node.label === 'script-entry')?.id ?? null, instrumentedNodeIds: [...observed].sort() };
}
