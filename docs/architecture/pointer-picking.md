# Pointer placement

`api.input.pointerEvents()` exposes raw **canvas-normalized** coordinates: x grows
rightward and y downward from the top-left, both in 0..1. These are not pixels,
NDC, world coordinates, or coordinates relative to a camera sub-viewport.

For scene placement, add `haiyue.interaction.pointer` to the receiving mesh and
enable the required events (`click` for a completed down/up on the same target,
or `down` for placement on press). Consume `api.input.interactions()`, filter by
`type` and stable `entityId`, and read `point` as world `[x, y, z]`. The engine owns
the camera projection and ray/mesh intersection. A physics raycast takes a world
ray; it is not a screen-picking API.

The game converts the hit to its logical grid, validates occupancy/bounds/rules,
and snaps to a cell or intersection. Picking and rendering must share the grid
origin, spacing and axes. For a transformed board, first convert the world point
to board space; do not apply a local grid directly to world coordinates. Texture
padding and line spacing must also match the grid. Do not estimate screen-to-world
scale from screenshots or duplicate camera FOV, aspect or ray math in scripts.

Meshes without an interaction component can still occlude the receiving surface.
Set decorative blockers to `penetrable: true` when they should not intercept rays.
The current picker handles Mesh3D; dynamically instanced stones do not become
individual pointer targets. Keep occupied-cell validation in game state.

See [the validated grid placement script](../examples/grid-placement.ts). It uses
an axis-aligned world XZ grid and an instanced marker. A board centered at the
origin can use a cube scaled to `{x:16,y:0.2,z:16}`, positioned at `y:-0.1`; its
top is y=0. Use a separate marker template and enable `click` on the board.

Regression coverage projects known world points into the actual camera, sends
native pointer events through the sandboxed Play canvas, and checks the observed
grid and rendered marker. Cases include the center and four corners, landscape
and portrait resize, translated/rotated cameras, perspective/orthographic
projection, and pixel scaling. Engine numerical tests additionally cover reverseZ
and negative orthographic near planes.

The Engine candidate retains the existing packed candidate as its exact baseline
(the archive and its digest are recorded in `config/engine-candidate.json`). That
archive already contains adaptations beyond its recorded source revision
`10a21e64b32315bf88ed48066d806071e0f17bf0`; rebuilding that revision alone loses them.
The patched Ray module is built with Rollup from that revision plus the recorded
source/test patch. Only this generated module and four incoming import references
are replaced in the existing package; all declarations and other modules are
preserved. The generated module has its own digest and the candidate remains
locked by archive integrity. It does not include unrelated changes from the
current Engine checkout or change public method signatures.
