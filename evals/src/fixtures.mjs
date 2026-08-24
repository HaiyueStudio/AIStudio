import { deepClone, deepFreeze } from './canonical.mjs';

export function createReferenceFixtureAdapter(referenceEvidence) {
  return new FixtureAdapter(referenceEvidence, 'reference');
}

export function createBlankFixtureAdapter() {
  return new FixtureAdapter({ cases: [] }, 'blank');
}

class FixtureAdapter {
  constructor(referenceEvidence, kind) {
    this.kind = kind;
    this.fixtures = new Map(referenceEvidence.cases.map((entry) => [entry.caseId, entry]));
    this.resets = [];
    this.agentInputs = [];
    this.current = null;
  }

  async resetProject(specification) {
    this.current = { specification, observations: [] };
    this.resets.push(deepFreeze(deepClone(specification)));
    return deepFreeze({ projectId: specification.document.id, documentDigest: specification.documentDigest, revision: 0 });
  }

  async executeAgent({ agentInput, runContext }) {
    if (!this.current) throw new Error('Project must be reset before Agent execution.');
    this.agentInputs.push(deepFreeze(deepClone(agentInput)));
    return deepFreeze({ terminal: this.kind === 'blank' ? 'completed-without-evidence' : 'completed', turns: 1, toolCalls: 2, runId: runContext.runId });
  }

  async executeReplay({ replay, failureSeedId, runContext }) {
    if (!this.current) throw new Error('Project must be reset before replay.');
    const fixture = this.fixtures.get(runContext.caseId);
    if (!fixture) { this.current.observations = []; return deepFreeze({ stepsExecuted: replay.steps.length, observations: 0 }); }
    const observations = deepClone(fixture.observations);
    if (failureSeedId) {
      const failure = fixture.failureSeeds.find((entry) => entry.id === failureSeedId);
      if (!failure) throw new Error(`Unknown fixture failure seed ${failureSeedId}.`);
      for (const override of failure.overrides) {
        const observation = observations.find((entry) => entry.type === override.evidenceType);
        if (!observation || !Object.hasOwn(observation.signals, override.signal)) throw new Error(`Invalid fixture override ${override.evidenceType}:${override.signal}.`);
        observation.signals[override.signal] = override.value;
      }
    }
    this.current.observations = observations;
    return deepFreeze({ stepsExecuted: replay.steps.length, observations: observations.length });
  }

  async collectEvidence() {
    if (!this.current) throw new Error('Project must be reset before evidence collection.');
    return deepFreeze(deepClone(this.current.observations));
  }

  async dispose() { this.current = null; }
}
