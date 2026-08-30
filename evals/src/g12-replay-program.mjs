import { deepClone, deepFreeze } from './canonical.mjs';

export const G12_SEMANTIC_REPLAY_ACTIONS = deepFreeze([
  'scripted-aim-and-fire',
  'scripted-complete-jigsaw',
  'scripted-complete-lap',
  'scripted-complete-level',
  'scripted-drag-piece',
  'scripted-fire-at-covered-enemy',
  'scripted-follow-centerline',
  'scripted-place-pieces',
  'scripted-repeat-valid-swaps',
  'scripted-resolve-combat',
  'scripted-steer',
  'scripted-swap',
]);

const DIRECT_ACTIONS = new Set(['press', 'hold', 'sequence']);
const SEMANTIC_ACTIONS = new Set(G12_SEMANTIC_REPLAY_ACTIONS);

/**
 * Compile one hidden replay into a backend-neutral, fixed-tick program.
 * `baseTick` is the authoritative paused tick after the real iframe starts;
 * suite ticks are offsets and never assume that WebGPU initialization paused at tick zero.
 */
export function compileG12ReplayProgram(inputReplay, { baseTick = 0 } = {}) {
  if (!Number.isSafeInteger(baseTick) || baseTick < 0) throw new G12ReplayProgramError('g12.replay-base-tick-invalid', 'Replay base tick must be a non-negative integer.');
  if (!inputReplay || inputReplay.driver !== 'fixed' || !Array.isArray(inputReplay.steps)) throw new G12ReplayProgramError('g12.replay-invalid', 'A fixed replay with steps is required.');
  const commands = [];
  let playReadyCursor = baseTick + 1;
  for (const [ordinal, step] of inputReplay.steps.entries()) {
    validateStep(step, ordinal);
    const schedule = compileSchedule(step.at, baseTick, playReadyCursor);
    if (schedule.kind === 'tick') playReadyCursor = Math.max(playReadyCursor, schedule.tick + 1);
    if (step.action === 'press' || step.action === 'hold') {
      const duration = step.durationTicks ?? 1;
      commands.push(command(step, ordinal, schedule, 'input', { control: step.control, phase: 'down' }));
      commands.push(command(step, ordinal, offsetSchedule(schedule, duration), 'input', { control: step.control, phase: 'up' }));
    } else if (step.action === 'sequence') {
      const controls = step.parameters.controls;
      controls.forEach((control, index) => {
        const down = offsetSchedule(schedule, index * 2);
        commands.push(command(step, ordinal, down, 'input', { control, phase: 'down' }, index));
        commands.push(command(step, ordinal, offsetSchedule(down, 1), 'input', { control, phase: 'up' }, index));
      });
    } else {
      commands.push(command(step, ordinal, schedule, 'semantic-driver', { driverId: step.action, parameters: deepClone(step.parameters ?? {}) }));
    }
  }
  return deepFreeze({ schemaVersion: 1, clock: 'fixed-tick-relative-to-paused-start', baseTick, commands });
}

export function assertG12SemanticDriverCoverage(programs, driverIds) {
  const available = new Set(driverIds);
  const required = new Set(programs.flatMap((program) => program.commands.filter((entry) => entry.kind === 'semantic-driver').map((entry) => entry.driverId)));
  const missing = [...required].filter((id) => !available.has(id)).sort();
  const unknown = [...available].filter((id) => !SEMANTIC_ACTIONS.has(id)).sort();
  if (missing.length || unknown.length) throw new G12ReplayProgramError('g12.semantic-driver-coverage-invalid', `Missing drivers: ${missing.join(', ') || 'none'}; unknown drivers: ${unknown.join(', ') || 'none'}.`, { missing, unknown });
  return deepFreeze({ required: [...required].sort(), available: [...available].sort() });
}

function compileSchedule(value, baseTick, playReadyCursor) {
  if (value === 'play-ready') return { kind: 'tick', tick: playReadyCursor };
  const tick = /^tick:(\d+)$/u.exec(value);
  if (tick) return { kind: 'tick', tick: baseTick + Number(tick[1]) };
  const trigger = /^after:([A-Za-z0-9._:-]+)$/u.exec(value);
  if (trigger) return { kind: 'trigger', trigger: trigger[1] };
  throw new G12ReplayProgramError('g12.replay-schedule-invalid', `Unsupported replay schedule ${String(value)}.`);
}

function offsetSchedule(schedule, ticks) {
  if (schedule.kind === 'tick') return { kind: 'tick', tick: schedule.tick + ticks };
  return { kind: 'trigger-offset', trigger: schedule.trigger, offsetTicks: ticks };
}

function command(step, ordinal, schedule, kind, payload, part = 0) {
  return { id: `g12-replay:${ordinal + 1}:${part + 1}`, sourceStepId: step.id, ordinal, schedule, kind, ...payload };
}

function validateStep(step, ordinal) {
  if (!step || typeof step.id !== 'string' || !step.id || typeof step.at !== 'string' || typeof step.action !== 'string') throw new G12ReplayProgramError('g12.replay-step-invalid', `Replay step ${ordinal + 1} is invalid.`);
  if (!DIRECT_ACTIONS.has(step.action) && !SEMANTIC_ACTIONS.has(step.action)) throw new G12ReplayProgramError('g12.replay-action-unsupported', `Replay action ${step.action} has no reviewed driver contract.`);
  if (step.action === 'press' || step.action === 'hold') {
    if (typeof step.control !== 'string' || !step.control || !Number.isSafeInteger(step.durationTicks) || step.durationTicks < 1 || step.durationTicks > 10_000) throw new G12ReplayProgramError('g12.replay-input-invalid', `Replay input ${step.id} is invalid.`);
  }
  if (step.action === 'sequence') {
    if (!step.parameters || !Array.isArray(step.parameters.controls) || step.parameters.controls.length < 1 || step.parameters.controls.length > 64 || step.parameters.controls.some((value) => typeof value !== 'string' || !value)) throw new G12ReplayProgramError('g12.replay-sequence-invalid', `Replay sequence ${step.id} is invalid.`);
  }
  if (SEMANTIC_ACTIONS.has(step.action) && (!step.parameters || typeof step.parameters !== 'object' || Array.isArray(step.parameters))) throw new G12ReplayProgramError('g12.replay-semantic-parameters-invalid', `Replay semantic action ${step.id} requires parameters.`);
}

export class G12ReplayProgramError extends Error {
  constructor(code, message, details = undefined) { super(message); this.name = 'G12ReplayProgramError'; this.code = code; this.details = details; }
}
