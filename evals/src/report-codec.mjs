import { canonicalStringify, contentDigest, deepFreeze } from './canonical.mjs';

export function encodeEvaluationReport(report) {
  validateReport(report);
  return `${canonicalStringify(report)}\n`;
}

export function decodeEvaluationReport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024) throw new EvaluationReportError('eval.report-size-invalid', 'Report is empty or oversized.');
  const report = JSON.parse(text);
  validateReport(report);
  if (encodeEvaluationReport(report) !== text) throw new EvaluationReportError('eval.report-noncanonical', 'Report is not canonical.');
  return deepFreeze(report);
}

export function evaluationReportDigest(report) { validateReport(report); return contentDigest(report); }

function validateReport(report) {
  if (!report || report.schemaVersion !== 1 || typeof report.suiteId !== 'string' || typeof report.suiteVersion !== 'string' || !Array.isArray(report.runs)) {
    throw new EvaluationReportError('eval.report-invalid', 'Evaluation report envelope is invalid.');
  }
  if (!report.summary || report.summary.total !== report.runs.length || report.summary.passed + report.summary.failed !== report.summary.total) {
    throw new EvaluationReportError('eval.report-summary-invalid', 'Evaluation report summary is inconsistent.');
  }
  for (const run of report.runs) {
    if (!['pass', 'fail'].includes(run.status) || !Array.isArray(run.acceptanceResults) || typeof run.evidenceManifestDigest !== 'string') {
      throw new EvaluationReportError('eval.report-run-invalid', `Evaluation report run ${run.runId ?? 'unknown'} is invalid.`);
    }
    const accounting = run.accounting;
    if (!accounting || !['within', 'soft-exceeded', 'hard-exceeded'].includes(accounting.budgetStatus) || !Array.isArray(accounting.usageRecordIds) || !Array.isArray(accounting.costRecordIds) || !Array.isArray(accounting.turns) || !Array.isArray(accounting.tools)
      || accounting.turns.length !== run.execution.turns || accounting.tools.length !== run.execution.toolCalls
      || accounting.turns.some((turn) => !turn.usageRecordIds.length) || accounting.tools.some((tool) => !tool.usageRecordIds.length)) {
      throw new EvaluationReportError('eval.report-accounting-invalid', `Evaluation report run ${run.runId ?? 'unknown'} has incomplete accounting links.`);
    }
  }
}

export class EvaluationReportError extends Error {
  constructor(code, message) { super(message); this.name = 'EvaluationReportError'; this.code = code; }
}
