import { deepFreeze } from './canonical.mjs';
import ts from 'typescript';

/** Genre-neutral static gate for the model-authored gameplay telemetry contract. */
export function inspectG12GameplayContract(scriptCatalog) {
  const resources = Array.isArray(scriptCatalog?.resources) ? scriptCatalog.resources.filter((entry) => entry?.enabled !== false) : [];
  let observationCallCount = 0; let hasTriggerChannel = false; let hasStateChannel = false;
  for (const [index, resource] of resources.entries()) {
    const source = ts.createSourceFile(`gameplay-contract-${index}.ts`, typeof resource.text === 'string' ? resource.text : '', ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const sceneAliases = collectSceneAliases(source);
    const objectLiterals = collectObjectLiterals(source);
    const visit = (node) => {
      if (ts.isCallExpression(node) && isSceneObserveCall(node.expression, sceneAliases)) {
        observationCallCount += 1;
        const payload = resolveObjectLiteral(node.arguments[1], objectLiterals);
        if (payload) {
          const keys = new Set(payload.properties.map(propertyName).filter(Boolean));
          hasTriggerChannel ||= keys.has('events') || keys.has('triggers');
          hasStateChannel ||= keys.has('status') || keys.has('state') || keys.has('phase');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const diagnostics = [];
  if (observationCallCount === 0) diagnostics.push('g12.gameplay-observation-call-missing');
  if (!hasTriggerChannel) diagnostics.push('g12.gameplay-trigger-channel-missing');
  if (!hasStateChannel) diagnostics.push('g12.gameplay-state-channel-missing');
  return deepFreeze({ schemaVersion: 1, valid: diagnostics.length === 0, scriptCount: resources.length, observationCallCount, diagnostics });
}

function isSceneObserveCall(expression, sceneAliases) {
  const call = unwrap(expression);
  if (!ts.isPropertyAccessExpression(call) || call.name.text !== 'observe') return false;
  const receiver = unwrap(call.expression);
  return ts.isIdentifier(receiver) ? sceneAliases.has(receiver.text)
    : ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'scene';
}

function collectSceneAliases(source) {
  const aliases = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrap(node.initializer);
      if ((ts.isPropertyAccessExpression(value) && value.name.text === 'scene') || (ts.isIdentifier(value) && aliases.has(value.text))) aliases.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return aliases;
}

function collectObjectLiterals(source) {
  const values = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = resolveObjectLiteral(node.initializer, values);
      if (value) values.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

function resolveObjectLiteral(expression, objectLiterals) {
  if (!expression) return null;
  const value = unwrap(expression);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (ts.isIdentifier(value)) return objectLiterals.get(value.text) ?? null;
  if (ts.isCallExpression(value) && value.arguments.length > 0 && ts.isPropertyAccessExpression(value.expression)
    && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === 'Object' && value.expression.name.text === 'freeze') {
    return resolveObjectLiteral(value.arguments[0], objectLiterals);
  }
  return null;
}

function unwrap(expression) {
  let value = expression;
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
  return value;
}

function propertyName(property) {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
}
