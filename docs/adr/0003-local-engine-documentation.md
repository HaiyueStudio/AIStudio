# ADR 0003 — Version-bound local Engine documentation

Status: Accepted for local implementation.

Engine APIs outgrow fixed prompts. Native Engine exports, declarative authoring and Play script APIs have different availability. A search hit must not imply all three support the same operation.

The private game-authoring-tools build generates an immutable documentation corpus from installed Engine public exports/declarations, the exact Studio script declaration generator, authoritative tool/component registries, and a digest-pinned Engine reference companion artifact. Engine maintains and exports its own guides; AIStudio consumes the reviewed artifact, never sibling source imports. Studio-specific guides are maintained once as files and reused by automatic retrieval and explicit tools. Generated signature bodies remain atomic, including overloads.

The corpus binding records Engine version and integrity, script contract digest and upstream guide digest. Electron main verifies the installed script contract and release binding, reads only shipped resources and shares the immutable index across backend profiles. Missing or stale documentation is explicit; the app does not substitute unrelated current online documentation.

`engine.docs.search` and `engine.docs.read` are bounded, low-risk observe tools in the existing registry, exposed through both backend profiles. Default searches include only Studio authoring and script routes. Native integration references require an explicit surface selection. Search returns summaries; read returns complete blocks and version-bound continuation cursors. Tool reads persist immutable result artifacts and project-correlated facts for replay. No new task, context, observation or approval envelopes are defined.

The prompt retains one generic discovery/read rule. Detailed instance and camera API instructions move out of the always-on workflow. Current read references can be reused; after context compaction the model may read them again. A documentation receipt is not gameplay acceptance evidence: actual input, transforms and images still require Play verification.

Validation covers public barrel resolution, Chinese discovery, native/script separation, integrity and stale cursors, byte budgets, complete pagination, result artifacts, real script compilation and Engine transform execution. Native guide examples are source references, not automatically certified Studio examples. Semantic search improvements or stricter API coverage policies require measured evidence, not inferred success from document counts.
