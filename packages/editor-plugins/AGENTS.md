# Editor plugins instructions

- Consume only public Engine/UI/Editor package exports and Studio service contracts.
- UI and Agent actions share the same validated Document command and History transaction path.
- Never expose mutable World, Store, DOM, or GPU objects through services or tool results.
- GameDocument v2 and ComponentDefinition are owned by `@haiyue/ai-studio-contracts`; adapters implement registered public Engine/Editor seams and may not define a second document/component envelope.
