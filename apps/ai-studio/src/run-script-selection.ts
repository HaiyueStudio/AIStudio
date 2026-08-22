export interface ProjectRunEntityCandidate {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export interface ProjectRunScriptCandidate {
  readonly id: string;
  readonly entityId: string;
  readonly name?: string;
  readonly textRevision: number;
}

/** Select the project controller independently from incidental Scene selection. */
export function selectProjectRunScript<T extends ProjectRunScriptCandidate>(
  entities: readonly ProjectRunEntityCandidate[],
  scripts: readonly T[],
  activeEntityId: string | null,
): T | undefined {
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  return scripts
    .map((script, index) => ({ script, index, score: runCandidateScore(script, entitiesById.get(script.entityId), activeEntityId) }))
    .filter((candidate) => candidate.score !== Number.NEGATIVE_INFINITY)
    .sort((left, right) => right.score - left.score || right.script.textRevision - left.script.textRevision || left.index - right.index)[0]?.script;
}

function runCandidateScore(
  script: ProjectRunScriptCandidate,
  entity: ProjectRunEntityCandidate | undefined,
  activeEntityId: string | null,
): number {
  if (!entity) return Number.NEGATIVE_INFINITY;
  const identity = `${entity.name} ${script.name ?? ''}`;
  let score = Math.min(Math.max(script.textRevision, 0), 50);
  if (/game|controller|logic|root|manager|main/i.test(identity)) score += 200;
  if (entity.kind === 'empty') score += 100;
  if (script.entityId === activeEntityId) score += 20;
  return score;
}
