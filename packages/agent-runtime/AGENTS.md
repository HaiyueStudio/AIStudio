# Agent runtime instructions

- Own provider-neutral AgentBackend, conversation projection, turn/step state, cancellation, and durable correlations.
- Do not import DeepSeek Harness, Codex wire schemas, editor implementations, or renderer code.
- Model-visible context must be reconstructable from durable events or immutable artifacts.
