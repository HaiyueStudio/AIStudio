import type { OperationLog } from '@haiyue/ai-studio-operation-log';
import { ContextCompactionRuntime, type CompactionRuntimeOptions, type CompactionSummarizer } from '../compaction/index.js';
import { DurableSessionRuntime } from '../session/index.js';
import { ContextFrameRuntime } from './frame.js';

export class ModelContextRuntime {
  readonly frames: ContextFrameRuntime;
  private readonly compactors = new Set<ContextCompactionRuntime>();
  private readonly frameRuntimes = new Set<ContextFrameRuntime>();
  private disposed = false;

  constructor(private readonly log: OperationLog, private readonly sessions: DurableSessionRuntime) {
    this.frames = new ContextFrameRuntime(log, sessions);
  }

  createCompactor(summarizer: CompactionSummarizer, options?: CompactionRuntimeOptions): ContextCompactionRuntime {
    this.assertActive();
    const compactor = new ContextCompactionRuntime(this.log, this.sessions, summarizer, options);
    this.compactors.add(compactor);
    return compactor;
  }

  createPipeline(summarizer: CompactionSummarizer, options?: CompactionRuntimeOptions): Readonly<{ compactions: ContextCompactionRuntime; frames: ContextFrameRuntime }> {
    this.assertActive();
    const compactions = this.createCompactor(summarizer, options);
    const frames = new ContextFrameRuntime(this.log, this.sessions, compactions, { estimator: options?.estimator });
    this.frameRuntimes.add(frames);
    return Object.freeze({ compactions, frames });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.frames.dispose();
    for (const frames of this.frameRuntimes) frames.dispose();
    this.frameRuntimes.clear();
    await Promise.all([...this.compactors].map((compactor) => compactor.dispose()));
    this.compactors.clear();
  }

  private assertActive(): void { if (this.disposed) throw new Error('Model context runtime is disposed.'); }
}
