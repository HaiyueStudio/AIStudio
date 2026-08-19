# Editor plugins instructions

- Consume only public Engine/UI/Editor package exports and Studio service contracts.
- UI and Agent actions share the same validated Document command and History transaction path.
- Never expose mutable World, Store, DOM, or GPU objects through services or tool results.
