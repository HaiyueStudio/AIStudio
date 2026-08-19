# M06 capability ownership matrix

| Capability | Owner plugin/package | Consumers | Durable facts | Fail-closed condition |
| --- | --- | --- | --- | --- |
| root lifecycle/effects | `harness-bridge` | all plugins | activate/rollback/disable/dispose | owner relation unknown |
| stable service facade | `studio-kernel` | all Studio plugins | registration diagnostics | duplicate provider |
| project/document/history | editor provider adapter | UI, tools, preview | command/revision/save/undo | log unavailable or stale revision |
| immutable scene query | AIStudio Scene adapter over Engine public API | hierarchy, viewport, tools | snapshot digest/revision | Engine/capability absent |
| scene mutation | AIStudio Scene adapter + M03 History | UI and tools | prepare/commit/rollback | invalid schema/revision/approval |
| operation log | `operation-log` | runtime, UI, diagnostic tool | append/recovery/rotation | integrity failure blocks mutation |
| conversation/tool policy | `agent-runtime` | both backends, chat | turn/node/call/result | unknown external payload |
| API-key backend | `agent-backends` + `harness-bridge` | agent runtime | auth state/usage, never secret | secret store unavailable |
| Codex backend | `agent-backends` | agent runtime | process/protocol/auth/rate status | schema/process mismatch |
| panels and typed IPC | `studio-shell` | renderer/main | intent/result/diagnostic | unknown channel/version |
| trusted preview | `script-preview` | script UI/tool | validation/start/stop/error | approval/log/runtime owner absent |

Backend 不拥有 Studio tool registry、approval policy、Document、History 或 durable log；因此更换 backend 不改变这些能力。
