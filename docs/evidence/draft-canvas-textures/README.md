# Draft Canvas textures and acceptance presentation

The reported board-texture failure was a saved-project precondition, before Canvas rendering. Both the tool and workspace required a project directory. New untitled projects now retain validated generated PNG bytes in their document-owned draft; existing controlled asset reads and renderer IPC can use them immediately. First save writes content-addressed PNGs before the project file, including undone assets needed for Redo. Saving fails without rebinding the project or dropping draft bytes; only newly staged files are rolled back. Successful save releases memory. Project replacement/close/disposal releases the draft, with a 64 MiB aggregate limit and existing per-texture limits. This is in-memory draft data with the same lifetime as the unsaved project, not crash recovery or an automatic save.

The exact approval, document identity, revision, History and PNG validation paths remain in force. Tests cover draft material assignment, immutable reads, save failure/retry, Undo/Redo across first save, reopen, cancellation, concurrent replacement, memory limits and project isolation. A workspace regression also exposed a platform-specific path bug: Windows absolute paths were accepted by the generic resolver on macOS. The resolver now rejects absolute paths from either platform; the original test is unchanged.

Task presentation distinguishes active acceptance (running; 验收处理中), ended turns lacking evidence (结果待核验; 待继续验收), and actual failures. The latter retain concrete diagnostics; historical texture.project-unsaved records explain that the existing project has not been saved to a directory. Tool failures no longer append a misleading generic acceptance sentence. This does not mark incomplete tasks successful or fabricate ongoing backend activity.

Native Canvas generated a 15-line board grid. The fixture checks actual pixels, retrieves the PNG through the current controlled IPC before save, then verifies bytes after saving and reopening. See draft-grid.png. No current user project was changed and the current desktop app was not restarted.

Native graph checks additionally assert the pending goal uses amber (rgb(60,52,32)), has no running border beam, and labels its detail as awaiting verification. Concrete PNG failure remains red (rgb(82,38,48)) with the precise unsaved-project explanation. The task panel uses a separate amber awaiting-acceptance class.

## Final verification

Formal current-source verification: 18 groups, 279 passed. Focused Canvas tools (4), graph model (22), workspace (13), native Canvas (1), native graph (1), and task product (10) checks passed. The initial workspace run exposed the Windows absolute-path rejection defect; workspace-final.log records its successful correction.

The root check passed contracts, types, boundaries, candidate checks, evaluation suites, formal census, builds, bundled docs and 33 behavior tests. Workspace tests had 4 passes and the existing failure at split-layout.test.mjs:69: UI 0.1.4 versus the stale expected 0.1.3. Later root stages were not reached. That unrelated assertion and dependency were not changed.
