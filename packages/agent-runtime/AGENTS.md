# Agent runtime instructions

- Own provider-neutral AgentBackend, conversation projection, turn/step state, cancellation, and durable correlations.
- Do not import DeepSeek Harness, Codex wire schemas, editor implementations, or renderer code.
- Model-visible context must be reconstructable from durable events or immutable artifacts.
- Consume M12 AgentTurnConfig, Usage/Cost/Budget, ContextArtifact, TaskSpec, and Evaluation contracts from `@haiyue/ai-studio-contracts`; do not create backend-specific shared envelopes.
