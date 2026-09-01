import type { ContextPressureV1 } from '@haiyue/ai-studio-contracts';
import type { ContextMeasurementResult, ContextPressureOptions, TokenEstimator } from './types.js';

export const DEFAULT_CONTEXT_THRESHOLDS = Object.freeze({ warning: 0.65, preparing: 0.75, compact: 0.8, emergency: 0.92 });

export class ContextPolicyError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = 'ContextPolicyError'; }
}

export class ConservativeTokenEstimator implements TokenEstimator {
  estimate(text: string, _model: string): number {
    if (typeof text !== 'string') throw new ContextPolicyError('context.input-invalid', 'Token estimation input must be text.');
    if (text.length === 0) return 0;
    let tokens = 0;
    let asciiRun = 0;
    const flush = (): void => { if (asciiRun > 0) { tokens += Math.ceil(asciiRun / 4); asciiRun = 0; } };
    for (const character of text) {
      const point = character.codePointAt(0)!;
      if (point <= 0x7f && /[A-Za-z0-9_]/u.test(character)) asciiRun += 1;
      else {
        flush();
        if (/\s/u.test(character)) continue;
        tokens += point > 0x7f ? 1 : 1;
      }
    }
    flush();
    return Math.max(1, tokens);
  }
}

export class ContextPressureCalculator {
  readonly thresholds: Readonly<{ warning: number; preparing: number; compact: number; emergency: number }>;

  constructor(options: ContextPressureOptions = {}) {
    const thresholds = {
      warning: options.warningRatio ?? DEFAULT_CONTEXT_THRESHOLDS.warning,
      preparing: options.preparingRatio ?? DEFAULT_CONTEXT_THRESHOLDS.preparing,
      compact: options.compactRatio ?? DEFAULT_CONTEXT_THRESHOLDS.compact,
      emergency: options.emergencyRatio ?? DEFAULT_CONTEXT_THRESHOLDS.emergency,
    };
    if (![thresholds.warning, thresholds.preparing, thresholds.compact, thresholds.emergency].every((value) => Number.isFinite(value) && value > 0 && value <= 1)
      || !(thresholds.warning < thresholds.preparing && thresholds.preparing < thresholds.compact && thresholds.compact < thresholds.emergency)) {
      throw new ContextPolicyError('context.thresholds-invalid', 'Context thresholds must be ordered ratios in (0, 1].');
    }
    this.thresholds = Object.freeze(thresholds);
  }

  calculate(input: Readonly<{
    maxInputTokens: number | null;
    reservedOutputTokens: number;
    reservedSafetyTokens: number;
    usedInputTokens: number | null;
    measurement: ContextPressureV1['measurement'];
  }>): ContextMeasurementResult {
    const reservedOutputTokens = nonNegativeInteger(input.reservedOutputTokens, 'reserved output tokens');
    const reservedSafetyTokens = nonNegativeInteger(input.reservedSafetyTokens, 'reserved safety tokens');
    if (input.maxInputTokens === null || input.usedInputTokens === null) {
      return Object.freeze({
        usableInputTokens: null,
        pressure: Object.freeze({ maxInputTokens: input.maxInputTokens, reservedOutputTokens, reservedSafetyTokens, usedInputTokens: input.usedInputTokens, ratio: null, measurement: 'unavailable', state: 'unknown' }),
      });
    }
    const maxInputTokens = boundedCapacity(input.maxInputTokens);
    const usedInputTokens = nonNegativeInteger(input.usedInputTokens, 'used input tokens');
    const usableInputTokens = maxInputTokens - reservedOutputTokens - reservedSafetyTokens;
    if (usableInputTokens <= 0) throw new ContextPolicyError('context.reserve-invalid', 'Output and safety reserves consume the entire model input capacity.');
    const ratio = Math.min(1, usedInputTokens / usableInputTokens);
    const state = ratio >= this.thresholds.emergency ? 'emergency'
      : ratio >= this.thresholds.compact ? 'compact-required'
        : ratio >= this.thresholds.preparing ? 'preparing'
          : ratio >= this.thresholds.warning ? 'warning'
            : 'normal';
    return Object.freeze({
      usableInputTokens,
      pressure: Object.freeze({ maxInputTokens, reservedOutputTokens, reservedSafetyTokens, usedInputTokens, ratio, measurement: input.measurement, state }),
    });
  }
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ContextPolicyError('context.measurement-invalid', `Invalid ${label}.`);
  return value;
}
function boundedCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 100_000_000) throw new ContextPolicyError('context.measurement-invalid', 'Invalid maximum input tokens.');
  return value;
}
