# Pointer picking repair — 2026-09-11

## Diagnosis

The saved `fivestones` project at document revision 7 used raw
`api.input.pointerEvents()` coordinates multiplied by 35. Its orthographic camera
has a full vertical span of 17.5; the horizontal span depends on aspect. The saved
script also reversed the world Z direction. No engine raycast was used by that
script. Independently, Engine `Ray.setFromCamera` always used the camera center as
the ray origin, making orthographic picking diverge from the rendered projection.

The board texture has intersections at pixels 64, 128, …, 960 on a 1024-pixel image
mapped over a 15.5-unit cube face. The world spacing is therefore 0.96875, with
outer intersections at ±6.78125. The original unit spacing also misaligned stones
with texture lines even if the screen conversion were corrected.

## Changes

- Engine distinguishes the constant homogeneous w of orthographic projections.
  Rays use parallel forward directions and origins on the camera plane at each
  pointer location. ReverseZ and depth intervals crossing the camera preserve
  the direction. Perspective behavior and public signatures are preserved.
- AIStudio consumes the fixed generated Ray module through
  `haiyue-engine-0.1.0-orthographic-picking.tgz`. The original candidate is retained
  as the binary baseline because it contains adaptations beyond its recorded Git
  revision. The new archive replaces Ray and changes its four import references;
  all 569 package files are accounted for, and every declaration is unchanged.
  Source patch, baseline archive, compiled module and final archive digests are
  recorded in `config/engine-candidate.json` and checked by the candidate verifier.
- The repaired game uses `haiyue.interaction.pointer` click events on the board,
  filters stable entity id and top-face normal, converts world hits to grid indices,
  and shares texture-aligned spacing with rendering. Rendering now follows input
  processing in the same tick. Rules and occupancy remain script-owned.
- Tool descriptions, reviewed knowledge guides and the script declaration comments
  distinguish canvas coordinates from world hit points. A validated, genre-neutral
  grid-placement example demonstrates the complete supported path.

## Focused verification

- Engine ray/interaction tests: **15 passed**, including 120 projected-point
  round trips across center/corners, aspect, camera pose, projection and reverseZ,
  plus negative orthographic near planes.
- Engine repository typecheck passed; repository tests: **1270 passed** across
  shader-language, engine, animation-spec, extensions and example policy tests.
- AIStudio focused script, authoring-tool, camera and knowledge tests: **61 passed**.
- Isolated Electron 43.5.1 / WebGPU test: **40 clicks passed** at device scale 2.
  Each case checks observed grid state and cyan marker pixels at the independently
  projected world position. It covers center/four corners, 700×450 and 460×760
  canvases, moved/rotated cameras, orthographic and perspective projections.
  Input uses Chromium's trusted dispatch into the sandboxed preview iframe.
  Evidence: `/private/tmp/haiyue-pointer-placement-8P4vho/results.json`.
- The repaired five-in-a-row script passed strict validation and **225 cell**
  placement checks, occupied/outside rejection, five-in-a-row victory and reset
  clearing the rendered instances in the same tick.
- Candidate integrity/export checks, Engine module boundaries and synchronous
  renderer-prepare checks passed.
- Current-source M14 capability evidence capture: **123 passed** across all 12
  suites, including the two isolated behavior window checks; generated evidence
  was refreshed through the official capture command.

## Broader check limitations

- Engine architecture/API checks require the absent sibling `Editor` repository.
- Engine full example build timed out in the unrelated `gpu-driven-instancing`
  example; the isolated retry timed out building the shared example bundle. The
  engine library and earlier workspaces built successfully.
- Engine all-public-package verification initially timed out installing its npm
  consumer. A network-enabled retry completed and reported existing animation-spec
  executable-bit/package-size failures and extensions package/bundle-size budget
  failures. These unrelated release policies were not changed. The AIStudio
  packed candidate was installed locally and its actual WebGPU/input behavior was
  verified above.

## Project handoff

The repair was applied to a copy through `ProjectWorkspace` History commands and
`ProjectScriptService` proposal validation/commit, then saved as revision 9. The
original project is awaiting confirmation of its unsaved state before overwrite.
The running AIStudio window was not restarted.

- Ready copy: `/Users/qingque/Desktop/HaiyueStudio/fivestones-pointer-fixed`
- Before-repair manifest: `AIStudio/.cache/fivestones-before-pointer-fix.json`
- Repair log: `AIStudio/.cache/fivestones-pointer-repair-log`
- Game checks: `fivestones-pointer-fixed/verification.json`

Use the newly built AIStudio on the next user-controlled restart to load the
fixed candidate. The current process retains the previous runtime bundle.
