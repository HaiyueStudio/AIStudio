import type { StableId } from '@haiyue/ai-studio-contracts';
import type { ConversationTaskRunReadModel } from '@haiyue/ai-studio-shell';

type Task = Pick<ConversationTaskRunReadModel, 'taskId' | 'status' | 'phase' | 'backendId' | 'sessionId' | 'turnId'> & Partial<Pick<ConversationTaskRunReadModel, 'acceptance' | 'timeline'>>;

/** Preview belongs to active task execution; human handoffs return to authoring. */
export class AgentPreviewOwnership {
  private owner: { projectId: StableId; taskId: StableId } | null = null;
  private projectId: StableId | null = null;
  private tasks: readonly Task[] = [];

  update(projectId: StableId | null, tasks: readonly Task[]): void {
    this.projectId = projectId;
    this.tasks = tasks;
  }

  claim(projectId: StableId): void {
    const task = this.projectId === projectId ? this.tasks.find(task => task.status === 'running') : undefined;
    if (!task) throw new Error('Agent preview requires an active task in the current project.');
    this.owner = { projectId, taskId: task.taskId };
  }

  release(): void { this.owner = null; }
  get active(): boolean { return this.owner !== null; }
  get task(): Task | undefined {
    return this.owner?.projectId === this.projectId ? this.tasks.find(task => task.taskId === this.owner?.taskId) : undefined;
  }
  get shouldClose(): boolean {
    const task = this.task;
    return this.active && (!task || task.status !== 'running'
      || (task.status === 'running' && ['evaluating', 'repairing'].includes(task.phase)));
  }
}
