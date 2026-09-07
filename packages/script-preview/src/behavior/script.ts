import ts from 'typescript';
import type { BehaviorSourceV1, GameDocumentV2 } from '@haiyue/ai-studio-contracts';
import { BehaviorGraphBuilder } from './graph.js';

type Script = GameDocumentV2['scripts'][number];
type Source = Extract<BehaviorSourceV1, { kind: 'script' }>;
interface Flow { entry: string | null; normal: string[]; throws: string[]; returns: string[]; breaks: string[]; continues: string[] }
const empty = (): Flow => ({ entry: null, normal: [], throws: [], returns: [], breaks: [], continues: [] });
const one = (id: string | null): Flow => ({ ...empty(), entry: id, normal: id ? [id] : [] });

/** This is a bounded syntactic control-flow projection, not evaluation of project code. */
export function analyzeScript(script: Script, graph: BehaviorGraphBuilder): void {
  let file: ts.SourceFile;
  try { file = ts.createSourceFile(script.sourcePath, script.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
  catch {
    const lines = script.source.split(/\r\n|\r|\n/u);
    graph.node('unknown', { kind: 'script', entityId: script.entityId, scriptId: script.id, digest: script.digest, path: script.sourcePath,
      range: { start: 0, end: script.source.length, startLine: 1, startColumn: 1, endLine: lines.length, endColumn: lines.at(-1)!.length + 1 } }, 'parser-budget', 'budget');
    graph.truncate('ast'); return;
  }
  const source = (node: ts.Node): Source => {
    const start = node.getStart(file), end = node.getEnd();
    const a = file.getLineAndCharacterOfPosition(start), b = file.getLineAndCharacterOfPosition(end);
    return { kind: 'script', entityId: script.entityId, scriptId: script.id, digest: script.digest, path: script.sourcePath,
      range: { start, end, startLine: a.line + 1, startColumn: a.character + 1, endLine: b.line + 1, endColumn: b.character + 1 } };
  };
  // Count iteratively before any recursive analysis; TypeScript's parser is owned by the cancellable worker.
  const stack: { node: ts.Node; depth: number }[] = [{ node: file, depth: 0 }];
  let visited = 0, promiseUnsafe = false;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++visited > graph.config.maxAstNodes || depth > graph.config.maxAstDepth) {
      graph.node('unknown', source(file), 'ast-budget', 'budget'); graph.truncate('ast'); return;
    }
    // Shadowing or writing Promise anywhere makes intrinsic recognition conservative for the whole script.
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportClause(node)) && node.name?.getText(file) === 'Promise') promiseUnsafe = true;
    if (ts.isIdentifier(node) && node.text === 'Promise' && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === 'all' && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent)) promiseUnsafe = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && /^Promise(?:\.|\[|$)/u.test(node.left.getText(file))) promiseUnsafe = true;
    ts.forEachChild(node, child => { stack.push({ node: child, depth: depth + 1 }); });
  }
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) { graph.node('unknown', source(file), 'syntax-error', 'syntax-error'); return; }
  const edge = (from: string | null, to: string | null, kind: Parameters<BehaviorGraphBuilder['edge']>[2], node: ts.Node) => graph.edge(from, to, kind, source(node));
  const merge = (a: Flow, b: Flow, node: ts.Node): Flow => {
    if (!a.entry) return b; if (!b.entry) return a;
    for (const tail of a.normal) edge(tail, b.entry, 'sequence', node);
    if (!a.normal.length) return a;
    return { entry: a.entry, normal: b.normal, throws: [...a.throws, ...b.throws], returns: [...a.returns, ...b.returns], breaks: [...a.breaks, ...b.breaks], continues: [...a.continues, ...b.continues] };
  };
  const chain = (nodes: readonly ts.Node[]): Flow => nodes.reduce((flow, node) => merge(flow, visit(node), node), empty());
  function branch(node: ts.Node, condition: ts.Node, yes: ts.Node, no?: ts.Node): Flow {
    const check = graph.node('condition', source(condition));
    const test = merge(visit(condition), one(check), condition);
    const a = visit(yes), b = no ? visit(no) : empty();
    const join = graph.node('join', source(node), 'branch-join');
    edge(check, a.entry ?? join, 'true', condition); edge(check, b.entry ?? join, 'false', condition);
    for (const tail of [...a.normal, ...b.normal]) edge(tail, join, 'sequence', node);
    return { entry: test.entry, normal: (!a.entry || !b.entry || a.normal.length || b.normal.length) && join ? [join] : [], throws: [...test.throws, ...a.throws, ...b.throws], returns: [...a.returns, ...b.returns], breaks: [...a.breaks, ...b.breaks], continues: [...a.continues, ...b.continues] };
  }
  let analysisVisits = 0;
  function visit(node: ts.Node): Flow {
    if (++analysisVisits > graph.config.maxAstNodes) { graph.truncate('ast'); return one(graph.node('unknown', source(node), 'analysis-budget', 'budget')); }
    if (ts.isSourceFile(node) || ts.isBlock(node)) return chain(node.statements);
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const entry = graph.node('entry', source(node), 'function-entry');
      if (node.body) edge(entry, visit(node.body).entry, 'sequence', node.body);
      return one(graph.node('statement', source(node), 'function-definition'));
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) visit(member);
        else graph.node('unknown', source(member), 'class-initialization', 'unsupported-syntax');
      }
      return one(graph.node('unknown', source(node), 'class-definition', 'unsupported-syntax'));
    }
    if (ts.isIfStatement(node)) return branch(node, node.expression, node.thenStatement, node.elseStatement);
    if (ts.isConditionalExpression(node)) return branch(node, node.condition, node.whenTrue, node.whenFalse);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      // These evaluate the right operand conditionally; no unconditional sequence is asserted.
      const left = visit(node.left), check = graph.node('condition', source(node.left), ts.tokenToString(node.operatorToken.kind)!);
      const right = visit(node.right), join = graph.node('join', source(node), 'short-circuit-join');
      const first = merge(left, one(check), node.left);
      const evaluate = node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? 'true' : 'false';
      edge(check, right.entry ?? join, evaluate, node); edge(check, join, evaluate === 'true' ? 'false' : 'true', node);
      for (const tail of right.normal) edge(tail, join, 'sequence', node);
      return { ...first, normal: join ? [join] : [], throws: [...first.throws, ...right.throws] };
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node)) {
      const condition = ts.isForStatement(node) ? node.condition : node.expression;
      const loop = graph.node('loop', source(node), ts.isDoStatement(node) ? 'do-loop' : 'loop');
      const test = condition ? merge(visit(condition), one(loop), condition) : one(loop);
      const body = visit(node.statement), increment = ts.isForStatement(node) && node.incrementor ? visit(node.incrementor) : empty();
      const exit = graph.node('join', source(node), 'loop-exit');
      edge(loop, body.entry ?? increment.entry ?? test.entry, 'loop-body', node);
      if (condition) edge(loop, exit, 'false', condition);
      for (const tail of [...body.normal, ...body.continues]) edge(tail, increment.entry ?? test.entry, 'loop-back', node);
      for (const tail of increment.normal) edge(tail, test.entry, 'loop-back', node);
      for (const tail of body.breaks) edge(tail, exit, 'sequence', node);
      let flow: Flow = { entry: ts.isDoStatement(node) ? body.entry ?? test.entry : test.entry, normal: (condition || body.breaks.length) && exit ? [exit] : [], throws: [...test.throws, ...body.throws, ...increment.throws], returns: body.returns, breaks: [], continues: [] };
      if (ts.isForStatement(node) && node.initializer) flow = merge(visit(node.initializer), flow, node.initializer);
      return flow;
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isSwitchStatement(node) || ts.isLabeledStatement(node) || ts.isWithStatement(node)) {
      // Iterator protocols, fall-through and labels need a richer model; retain a precise source gap.
      return one(graph.node('unknown', source(node), ts.SyntaxKind[node.kind], 'unsupported-syntax'));
    }
    if (ts.isTryStatement(node)) {
      const entry = graph.node('try', source(node)); const body = visit(node.tryBlock);
      edge(entry, body.entry, 'sequence', node.tryBlock);
      let caught = empty();
      if (node.catchClause) {
        const catcher = graph.node('catch', source(node.catchClause));
        for (const tail of body.throws) edge(tail, catcher, 'exception', node.catchClause);
        caught = merge(one(catcher), visit(node.catchClause.block), node.catchClause);
        if (!body.throws.length) caught = empty();
      }
      const result: Flow = { entry, normal: [...(body.entry ? body.normal : entry ? [entry] : []), ...caught.normal], throws: node.catchClause ? caught.throws : body.throws, returns: [...body.returns, ...caught.returns], breaks: [...body.breaks, ...caught.breaks], continues: [...body.continues, ...caught.continues] };
      if (node.finallyBlock) {
        // Separate completion paths prevent a returning branch from falling through a shared finally.
        const completed: Flow = { ...empty(), entry };
        for (const category of ['normal', 'throws', 'returns', 'breaks', 'continues'] as const) {
          if (!result[category].length) continue;
          const final = graph.withContext(`finally:${node.pos}:${category}`, () => visit(node.finallyBlock!));
          for (const tail of result[category]) edge(tail, final.entry, 'finally', node.finallyBlock);
          completed[category].push(...(final.entry ? final.normal : result[category]));
          for (const override of ['throws', 'returns', 'breaks', 'continues'] as const) completed[override].push(...final[override]);
        }
        return completed;
      }
      return result;
    }
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      const kind = ts.isReturnStatement(node) ? 'return' : ts.isThrowStatement(node) ? 'throw' : 'statement';
      const id = graph.node(kind, source(node), ts.SyntaxKind[node.kind]);
      const expr = (ts.isReturnStatement(node) || ts.isThrowStatement(node)) && node.expression ? visit(node.expression) : empty();
      const flow = merge(expr, one(id), node); flow.normal = [];
      if (id) flow[ts.isReturnStatement(node) ? 'returns' : ts.isThrowStatement(node) ? 'throws' : ts.isBreakStatement(node) ? 'breaks' : 'continues'].push(id);
      return flow;
    }
    if (ts.isAwaitExpression(node)) {
      const expr = visit(node.expression), id = graph.node('await', source(node));
      for (const tail of expr.normal) edge(tail, id, 'await', node);
      return { ...expr, entry: expr.entry ?? id, normal: id ? [id] : [], throws: [...expr.throws, ...(id ? [id] : [])] };
    }
    if (ts.isCallExpression(node)) {
      const args = chain([node.expression, ...node.arguments]);
      const all = !promiseUnsafe && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Promise' && node.expression.name.text === 'all' && node.arguments.length === 1 && ts.isArrayLiteralExpression(node.arguments[0]) && node.arguments[0].elements.every(item => !ts.isSpreadElement(item));
      const call = graph.node('call', source(node), all ? 'Promise.all' : 'call', all ? null : 'dynamic-call');
      const flow = merge(args, one(call), node);
      if (call) flow.throws.push(call);
      if (all) {
        // Evaluation of array expressions stays serial above. These lanes describe aggregate settlement,
        // not actual overlap, start times, or successful execution of the argument calls.
        const fork = graph.node('fork', source(node), 'promise-settlements');
        const join = graph.node('join', source(node), 'all-fulfilled'); edge(call, fork, 'sequence', node);
        for (const item of (node.arguments[0] as ts.ArrayLiteralExpression).elements) {
          const lane = graph.node('unknown', source(item), 'promise-settlement', 'dynamic-call');
          edge(fork, lane, 'concurrent', item); edge(lane, join, 'join', item);
        }
        if (!(node.arguments[0] as ts.ArrayLiteralExpression).elements.length) edge(fork, join, 'join', node);
        // Waiting for fulfillment is asserted only by a syntactically enclosing await.
        if (ts.isAwaitExpression(node.parent)) flow.normal = join ? [join] : [];
      }
      return flow;
    }
    if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isYieldExpression(node)) return one(graph.node('unknown', source(node), ts.SyntaxKind[node.kind], 'unsupported-syntax'));
    if (ts.isExpressionStatement(node)) return visit(node.expression);
    if (ts.isVariableStatement(node)) return visit(node.declarationList);
    if (ts.isVariableDeclarationList(node)) return chain(node.declarations);
    if (ts.isVariableDeclaration(node)) return node.initializer ? merge(visit(node.initializer), one(graph.node('statement', source(node), 'binding')), node) : one(graph.node('statement', source(node), 'binding'));
    if (ts.isArrayLiteralExpression(node)) return chain(node.elements);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return visit(node.expression);
    if (ts.isBinaryExpression(node)) return merge(chain([node.left, node.right]), one(graph.node('statement', source(node), 'binary-operation')), node);
    if (ts.isObjectLiteralExpression(node)) return chain(node.properties);
    if (ts.isPropertyAssignment(node)) return visit(node.initializer);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const evaluated = chain(ts.isElementAccessExpression(node) ? [node.expression, node.argumentExpression] : [node.expression]);
      const id = graph.node('unknown', source(node), 'property-access', 'dynamic-call');
      const flow = merge(evaluated, one(id), node); if (id) flow.throws.push(id); return flow;
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return merge(visit(node.operand), one(graph.node('statement', source(node), 'unary-operation')), node);
    if (ts.isIdentifier(node) || ts.isLiteralExpression(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword, ts.SyntaxKind.ThisKeyword, ts.SyntaxKind.EmptyStatement].includes(node.kind)) return empty();
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return empty();
    return one(graph.node('unknown', source(node), ts.SyntaxKind[node.kind], 'unsupported-syntax'));
  }
  const root = graph.node('entry', source(file), 'script-entry');
  edge(root, visit(file).entry, 'sequence', file);
}
