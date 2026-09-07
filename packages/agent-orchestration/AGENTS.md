# Agent orchestration instructions

- Own headless conversation workflows, plan approval, budgets, task acceptance, replay and recovery coordination.
- Consume provider-neutral runtime and tool service exports. Do not import Electron, backend implementations, Harness, editor implementations, or app code.
- Use `@haiyue/ai-studio-shell/conversation` only for validated headless projections; do not import renderer panels or the shell root.
- Inject platform actions and recovery authority through ports. Filesystem claims, project adapters and login windows belong to the composition root.
- Initialization and disposal belong to the existing root effect tree. Do not add a root, scheduler, tool registry or mutation path.
- Keep tool arguments, approval revisions, durable correlation and evidence checks intact when splitting workflows. Shared versioned envelopes remain owned by studio-contracts.
