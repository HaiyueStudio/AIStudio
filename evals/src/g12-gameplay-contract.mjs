import { deepFreeze } from './canonical.mjs';
import ts from 'typescript';

/** Genre-neutral static gate for the model-authored gameplay telemetry contract. */
export function inspectG12GameplayContract(scriptCatalog) {
  const resources = Array.isArray(scriptCatalog?.resources) ? scriptCatalog.resources.filter((entry) => entry?.enabled !== false) : [];
  let observationCallCount = 0; let hasTriggerChannel = false; let hasStateChannel = false;
  for (const [index, resource] of resources.entries()) {
    const source = ts.createSourceFile(`gameplay-contract-${index}.ts`, typeof resource.text === 'string' ? resource.text : '', ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && isSceneObserveCall(node.expression)) {
        observationCallCount += 1;
        const payload = node.arguments[1];
        if (payload && ts.isObjectLiteralExpression(payload)) {
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

function isSceneObserveCall(expression) {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'observe'
    && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'scene';
}

function propertyName(property) {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
}
