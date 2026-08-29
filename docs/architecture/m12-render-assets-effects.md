# M12 render, assets, and effects runtime

G08 projects visual and content capabilities into the component registry as immutable descriptors. The authoring document stores render settings, stable asset ids, scalar material/light values, effect ordering, and animation/audio intent. GPU textures, decoded audio, parsed animation data, object URLs, glTF runtime entities, and Engine systems exist only in the Play owner.

## Controlled asset boundary

`ControlledAssetCatalog` accepts only project-contained paths under `assets/`, allowlisted MIME/extension pairs, verified PNG/JPEG/WebP/KTX2/audio/glTF/GLB signatures, bounded source and decoded sizes, header-matched texture dimensions, and explicit license/provenance. JSON/GLB structure is parsed before registration and external `uri`/`url`/`src` fields are rejected; contained data URIs remain source-budgeted. Content hashes deduplicate entries and become stable `asset:*` ids. The catalog is restored from and persisted to the versioned `studio.assets.catalog.v1` Document setting, so undo/redo, save/reopen, scene snapshots, Agent search, and Play all observe the same manifest. The approved `asset.import` and `asset.assign` tools commit catalog plus component changes through one History transaction; `asset.search` returns bounded metadata only. Arbitrary URLs, network fetches, absolute paths, traversal, and project-external files are not authoring inputs.

Play resolves texture, environment, glTF, HaiYue animation, and audio ids through injected controlled resolvers. Every resolved result has one release callback. Abort, partial install, failed install, late resolution, normal stop, and repeated stop converge through the same idempotent disposal path. A missing resolver fails closed. Live asset objects never enter GameDocument or tool results.

The desktop host exposes only `asset/read { assetId }`. It resolves the id against the current scene manifest, re-reads a contained regular file, verifies byte length and SHA-256, and returns a bounded base64 envelope without a filesystem path. The parent renderer scans enabled component values, loads at most 128 referenced assets under 64 MiB source / 256 MiB decoded aggregate budgets, and transfers only Blob URLs or bounded UTF-8 animation source to the sandboxed product iframe. The iframe CSP allows `blob:` for images/media/fetch but no network origin. Start failure, restart, and exit revoke every parent-owned object URL.

## Rendering and reconstruction

The render profile fixes pipeline profile, MSAA, clear color, logical DPR, and maximum render pixels before Engine construction. The runtime manifest adds logical and bounded pixel viewport dimensions, ordered post-process enable state, owner counts, and device state. Together with the document descriptors and pinned package candidates, this is the stable configuration used to reproduce a screenshot.

The core metallic-roughness PBR slots—base color, metallic-roughness, normal, occlusion, and emissive—use controlled texture resolution. glTF models use the stable `@haiyue/extensions/gltf` component/system and object URL lifetime. HaiYue 2D animation uses the stable `@haiyue/extensions/animation` simulation/render systems. Transform clips are compiled to immutable public `Animation3DClip` tracks and evaluated by `@haiyue/extensions/animation3d`'s `Animation3DMixer`, PoseBuffer, and PoseApplier; state changes can cross-fade on the same public clock. Directional shadows, environment light, distance/height fog, 2D/3D particles, and the supported post-process subset are installed in descriptor order and removed in reverse ownership order.

Audio sources inherit master/bus volume and mute state. Engine's music component installs browser unlock listeners only when playback needs a user gesture; the Play adapter explicitly enters that lifecycle because preview entities already exist in the World. Stop removes listeners, closes audio owners, and releases resolved assets.

## Failure and device behavior

- Invalid/stale entity targets and incompatible material targets fail before Play starts.
- Unsupported post-process kinds, absent controlled resolvers, digest/descriptor drift, malformed base64, and out-of-budget descriptors fail closed.
- Device loss pauses effect ticking and is visible in the manifest; device restoration resumes it.
- glTF load timeout is bounded by the descriptor and the extension system cancels/removes late loads.
- Stop removes systems/components, destroys the 3D mixer, removes generated animation/model hierarchies and unlock listeners, releases resolved assets, and revokes Blob URLs; disposal is idempotent.

## Explicit deferred seam

The G01 census classifies `prefab` as `missing-seam` / `blocked-public-seam`. G08 does not emulate it with script text or cross-repository imports. The controlled model/asset adapters are real public seams; prefab authoring remains an explicit candidate-expansion item for the integration owner.

## Visual acceptance

The deterministic fixture set covers snake, match-3, Tetris, jigsaw, platformer, racing, and shooter with genre-specific readability, differentiation, framing, and feedback oracles. One real Electron/WebGPU gate renders PBR materials, directional shadow, environment light, outline plus FXAA, and 3D particles, then checks dark/bright/chromatic population and luminance range from the captured bitmap—not merely the PNG header or file size. A second real Electron gate sends a controlled PNG Blob through the exact product `preview.html`, observes one texture and one material owner, stops the iframe, and requires zero residual disposables.
