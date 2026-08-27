import {
  FixedStepClock,
  ReplayInputController,
  hashSimulationState,
  type FixedStepTick,
  type InputReplayV1,
  type ReplayInputEventInput,
  type ReplayInputSnapshot,
  type SimulationStateValue,
} from '@haiyue/engine/experimental/simulation';

export interface PlaySimulationTraceEntry {
  readonly tick: number;
  readonly timeMs: number;
  readonly inputHash: string;
  readonly stateHash: string;
}

export interface PlaySimulationSnapshot {
  readonly tick: number;
  readonly timeMs: number;
  readonly paused: boolean;
  readonly seed: number | string;
  readonly input: ReplayInputSnapshot;
  readonly trace: readonly PlaySimulationTraceEntry[];
}

export interface PlaySimulationOptions {
  readonly tickRateHz?: number;
  readonly maxSubSteps?: number;
  readonly seed?: number | string;
  readonly maxTraceEntries?: number;
  readonly onTick: (step: FixedStepTick, input: ReplayInputSnapshot) => void;
  readonly readState?: () => SimulationStateValue;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, K>> : never;
export type NextReplayInputEvent = DistributiveOmit<ReplayInputEventInput, 'tick'>;

/** Deterministic Play authority. Display frames only contribute elapsed time. */
export class PlaySimulation {
  readonly clock: FixedStepClock;
  readonly input = new ReplayInputController();
  readonly seed: number | string;

  private readonly onTick: PlaySimulationOptions['onTick'];
  private readonly readState: NonNullable<PlaySimulationOptions['readState']>;
  private readonly maxTraceEntries: number;
  private readonly traceEntries: PlaySimulationTraceEntry[] = [];

  constructor(options: PlaySimulationOptions) {
    this.clock = new FixedStepClock({ tickRateHz: options.tickRateHz, maxSubSteps: options.maxSubSteps });
    this.seed = options.seed ?? 'haiyue-play';
    this.onTick = options.onTick;
    this.readState = options.readState ?? (() => ({ tick: this.clock.tick }));
    this.maxTraceEntries = boundedInteger(options.maxTraceEntries ?? 2_048, 1, 100_000, 'maxTraceEntries');
  }

  advanceDisplayFrame(deltaMs: number): number {
    return this.clock.advance(deltaMs, (step) => this.runTick(step)).ticks;
  }

  step(count = 1): number {
    return this.clock.step(count, (step) => this.runTick(step)).ticks;
  }

  pause(): void { this.clock.pause(); }
  resume(): void { this.clock.resume(); }

  inject(event: ReplayInputEventInput): void { this.input.inject(event); }

  injectNext(event: NextReplayInputEvent): void {
    this.input.inject({ ...event, tick: this.clock.tick + 1 } as ReplayInputEventInput);
  }

  loadReplay(replay: InputReplayV1): void {
    if (replay.tickRateHz !== this.clock.tickRateHz) throw new Error(`Replay tick rate ${replay.tickRateHz} does not match Play tick rate ${this.clock.tickRateHz}.`);
    if (replay.seed !== this.seed) throw new Error('Replay seed does not match Play seed.');
    this.clock.reset();
    this.input.load(replay);
    this.traceEntries.length = 0;
  }

  snapshot(): PlaySimulationSnapshot {
    return Object.freeze({
      tick: this.clock.tick,
      timeMs: this.clock.timeMs,
      paused: this.clock.paused,
      seed: this.seed,
      input: this.input.snapshot(),
      trace: Object.freeze([...this.traceEntries]),
    });
  }

  reset(): void {
    this.clock.reset();
    this.input.reset();
    this.traceEntries.length = 0;
  }

  private runTick(step: FixedStepTick): void {
    const input = this.input.beginTick(step.tick);
    this.onTick(step, input);
    this.traceEntries.push(Object.freeze({
      tick: step.tick,
      timeMs: step.timeMs,
      inputHash: input.hash,
      stateHash: hashSimulationState(this.readState()),
    }));
    if (this.traceEntries.length > this.maxTraceEntries) this.traceEntries.splice(0, this.traceEntries.length - this.maxTraceEntries);
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
