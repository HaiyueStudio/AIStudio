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

## Texture alignment

The 2026-09-14 Gomoku case drew 16 lines at pixels 16, 80, …, 976 on
a 1024px image, while its script used 15 intersections at world −7, −6, …, 7.
The script correctly consumed engine world hit points. Its visual and logical
grids disagreed; changing the pivot alone cannot correct differing spacing.

The example now derives snapping coordinates from the texture layout. For a
16-unit board, draw exactly 15 lines at 64, 128, …, 960, giving world −7…7.
Confirm the actual surface dimensions and UV directions, especially on cube faces.
Use the same layout when drawing, snapping and placing pieces. Test the texture
intersections and rendered positions, not just game-rule counters.

## Composite drag ownership and background arbitration

Configure interaction on the visible hit meshes before cloning a prototype. Existing assembly instances are snapshots: adding a pointer component to the original afterwards does not update the other instances. `assembly.inspect` checks whether the instances retain the prototype pointer configuration; repair each reported id before preview validation. A decorative face can occlude its body: either make that face explicitly penetrable or let it emit pointer events and map its stable id to the common motion owner. Test the centre of each visible face, not just an exposed body edge.

`api.read.findAll(name)` uses exact name equality, not role-key or substring matching. A role `motionRoot` in an assembly blueprint is not the runtime name `Cubie_1 · motionRoot`. Retain the returned `rootId`/`partIds` from assembly creation/instantiation and resolve them with `api.read.find(id)`. The script validator reports literal name lookups that do not match the current scene. If runtime entities are created later, check the later lookup explicitly.

At pointer down, match the same pointer id to an engine interaction and store its owner for the entire gesture. Only a confirmed background gesture may control the camera; missing configuration or an occluding decorative mesh is not proof of background. Capture move/up/cancel and clear ownership on cancellation. For a rotating group, derive the affected group from the hit point/normal and logical state, then update positions and orientations around the common pivot. Rotating the first N entities around their own origins is not a group rotation. Verify affected entity identities, count, position/orientation changes, unchanged nonmembers, and an unchanged camera during object drag. Script counters alone do not prove motion.

Stop Play and wait for `state: stopped` before applying edits. A stopped preview returns the authoring lifecycle to editing without resetting evidence or repair attempts; after editing, validate and start a fresh preview for new-revision evidence.

## 预览中的轨道相机

简单立方体查看器每个 onUpdate 调用一次 `api.scene.orbitControls({ mode: 'all' })`；完整可编译示例见 `docs/examples/orbit-camera.ts`。脚本需要 `input` 与 `scene`，校验器会对标准调用补齐能力披露，运行仍经过原有预览授权。初始相机用 camera.set 或 camera.author 设置。

这是 Studio 的固定步长控制接口，使用 Engine 的 SphericalTransform3D，不向脚本开放依赖 DOM 的原生 OrbitControl 构造器。真实输入与 Agent 输入均来自同一 ReplayInput 队列。支持左键拖拽、半径调整；透视相机的滚轮半径调整表现为缩放，正交投影的可见范围由其 orthographicSize/orthographicHeight 决定。本接口不宣称覆盖原生 OrbitControl 的全部平移/触摸手势。

默认项目相机及根层级的 3D 场景相机均可使用；场景相机在 Play 内转为球面变换，保持初始世界位置并朝向指定 target（默认原点）。每个相机只允许一个控制脚本；启用前禁用 camera.follow，避免两个控制器写同一相机。target 在首次绑定时使用。不会改写 Document 中的相机或物体变换。

有物体拖拽的游戏使用 `mode: 'background'`：在物体及可命中的子表面配置 haiyue.interaction.pointer，包含 down/up/cancel，控制器在 down 时判定归属并保持到 up/cancel，不因指针移出物体而改为旋转相机。原始碰撞表面未配置交互或被装饰挡住时，仍需修复命中覆盖；示例 `drag-target.ts` 已使用统一接口。失焦、断续调用与停止 Play 清除手势状态。

验收必须比较真实 `play.inspect.state.camera` 与物体变换，而非脚本自报计数。Electron 回归覆盖默认/场景相机、透视/正交、真实/注入拖拽，以及物体手势不移动相机。
