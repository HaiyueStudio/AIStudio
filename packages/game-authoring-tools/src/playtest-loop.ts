import { asStableId, type EvaluationResultV2, type JsonValue, type StableId, type TaskSpecV2 } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';

export type PlaytestTaskPhase = 'planning' | 'editing' | 'validating' | 'playing' | 'evaluating' | 'repairing' | 'complete' | 'blocked' | 'cancelled';

export interface RepairAttemptRecord {
  readonly iteration: number;
  readonly turnId: StableId;
  readonly argumentsDigest: string;
  readonly evidenceDigest: string;
  readonly evidenceIds: readonly StableId[];
  readonly usageRecordIds: readonly StableId[];
  readonly costRecordIds: readonly StableId[];
  readonly startedAt: string;
}

export interface PlaytestTaskSnapshot {
  readonly task: TaskSpecV2;
  readonly phase: PlaytestTaskPhase;
  readonly repairLimit: number;
  readonly attempts: readonly RepairAttemptRecord[];
  readonly evaluation: EvaluationResultV2 | null;
  readonly completionEvidenceIds: readonly StableId[];
  readonly terminalEvidenceIds: readonly StableId[];
  readonly diagnostic: string | null;
}

/**
 * Fail-closed lifecycle guard for an Agent playtest/repair loop.
 * It does not invoke a model: the product orchestrator owns turns and must ask this guard before each repair.
 */
export class BoundedPlaytestTask {
  private phaseValue: PlaytestTaskPhase = 'planning';
  private readonly attemptsValue: RepairAttemptRecord[] = [];
  private readonly fingerprints = new Set<string>();
  private evaluationValue: EvaluationResultV2 | null = null;
  private completionEvidenceIdsValue: readonly StableId[] = Object.freeze([]);
  private terminalEvidenceIdsValue: readonly StableId[] = Object.freeze([]);
  private diagnosticValue: string | null = null;

  constructor(readonly task: TaskSpecV2, readonly repairLimit: number) {
    if (!Number.isSafeInteger(repairLimit) || repairLimit < 0 || repairLimit > 100) throw new TypeError('Repair limit must be between zero and one hundred.');
  }

  snapshot(): PlaytestTaskSnapshot {
    return Object.freeze({ task: this.task, phase: this.phaseValue, repairLimit: this.repairLimit, attempts: Object.freeze([...this.attemptsValue]), evaluation: this.evaluationValue, completionEvidenceIds: this.completionEvidenceIdsValue, terminalEvidenceIds: this.terminalEvidenceIdsValue, diagnostic: this.diagnosticValue });
  }

  advance(next: Extract<PlaytestTaskPhase, 'editing' | 'validating' | 'playing' | 'evaluating'>): PlaytestTaskSnapshot {
    this.assertMutable();
    const allowed: Readonly<Record<PlaytestTaskPhase, readonly PlaytestTaskPhase[]>> = {
      planning: ['editing'], editing: ['validating'], validating: ['playing', 'editing'], playing: ['evaluating'], evaluating: ['editing'], repairing: ['editing'], complete: [], blocked: [], cancelled: [],
    };
    if (!allowed[this.phaseValue].includes(next)) throw new PlaytestLoopError('task.transition-invalid', `Cannot move task from ${this.phaseValue} to ${next}.`);
    this.phaseValue = next;
    return this.snapshot();
  }

  recordEvaluation(evaluation: EvaluationResultV2): PlaytestTaskSnapshot {
    this.assertMutable();
    if (this.phaseValue !== 'evaluating') throw new PlaytestLoopError('task.transition-invalid', 'Evaluation may only be recorded in evaluating phase.');
    if (evaluation.taskId !== this.task.id) throw new PlaytestLoopError('task.evaluation-mismatch', 'Evaluation belongs to another task.');
    this.evaluationValue = evaluation;
    if (evaluation.status === 'pass') {
      const evidence = [...new Set(evaluation.acceptanceResults.filter((item) => this.task.acceptance.find((acceptance) => acceptance.id === item.acceptanceId)?.required).flatMap((item) => item.evidenceIds))].sort();
      if (!evidence.length) throw new PlaytestLoopError('task.completion-without-evidence', 'A passing task must cite persisted evidence.');
      this.phaseValue = 'complete'; this.completionEvidenceIdsValue = Object.freeze(evidence.map((id) => asStableId(id))); this.terminalEvidenceIdsValue = this.completionEvidenceIdsValue; this.diagnosticValue = null;
    } else if (evaluation.status === 'blocked') {
      this.phaseValue = 'blocked'; this.diagnosticValue = 'task.evaluation-blocked';
    }
    return this.snapshot();
  }

  beginRepair(input: Readonly<{ turnId: StableId; arguments: JsonValue; evidenceIds: readonly StableId[]; usageRecordIds?: readonly StableId[]; costRecordIds?: readonly StableId[] }>): PlaytestTaskSnapshot {
    this.assertMutable();
    if (this.phaseValue !== 'evaluating' || this.evaluationValue?.status !== 'fail') throw new PlaytestLoopError('task.repair-unavailable', 'Repair requires a failed evaluation.');
    if (this.attemptsValue.length >= this.repairLimit) return this.block('task.repair-budget-exhausted', this.evaluationValue.acceptanceResults.flatMap((item) => item.evidenceIds).map((id) => asStableId(id)));
    const cited = new Set(input.evidenceIds);
    const failedEvidence = new Set(this.evaluationValue.acceptanceResults.filter((item) => item.status === 'fail').flatMap((item) => item.evidenceIds));
    if (!input.evidenceIds.length || !input.evidenceIds.some((id) => failedEvidence.has(id))) throw new PlaytestLoopError('task.repair-evidence-required', 'Repair must cite evidence from the latest failed evaluation.');
    if (cited.size !== input.evidenceIds.length) throw new PlaytestLoopError('task.repair-evidence-invalid', 'Repair evidence ids must be unique.');
    const argumentsDigest = sha256(canonicalStringify(input.arguments));
    const evidenceDigest = sha256(canonicalStringify([...input.evidenceIds].sort()));
    const fingerprint = `${argumentsDigest}:${evidenceDigest}`;
    if (this.fingerprints.has(fingerprint)) return this.block('task.repair-no-change-repeat', input.evidenceIds);
    this.fingerprints.add(fingerprint);
    this.attemptsValue.push(Object.freeze({
      iteration: this.attemptsValue.length + 1, turnId: input.turnId, argumentsDigest, evidenceDigest,
      evidenceIds: Object.freeze([...input.evidenceIds]), usageRecordIds: Object.freeze([...(input.usageRecordIds ?? [])]),
      costRecordIds: Object.freeze([...(input.costRecordIds ?? [])]), startedAt: new Date().toISOString(),
    }));
    this.phaseValue = 'repairing'; this.diagnosticValue = null;
    return this.snapshot();
  }

  cancel(evidenceIds: readonly StableId[] = []): PlaytestTaskSnapshot { if (!['complete', 'blocked', 'cancelled'].includes(this.phaseValue)) { this.phaseValue = 'cancelled'; this.terminalEvidenceIdsValue = Object.freeze([...evidenceIds]); } return this.snapshot(); }
  block(code: string, evidenceIds: readonly StableId[] = []): PlaytestTaskSnapshot { this.assertMutable(); this.phaseValue = 'blocked'; this.diagnosticValue = code.slice(0, 200); this.terminalEvidenceIdsValue = Object.freeze([...evidenceIds]); return this.snapshot(); }

  private assertMutable(): void { if (['complete', 'blocked', 'cancelled'].includes(this.phaseValue)) throw new PlaytestLoopError('task.terminal', `Task is already ${this.phaseValue}.`); }
}

export class PlaytestLoopError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PlaytestLoopError'; }
}

export function createTaskSpecId(seed: string): StableId { return asStableId(`task:${sha256(seed).slice(7, 31)}`); }
