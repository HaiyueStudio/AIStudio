# G07 dual Agent backend revalidation — 2026-08-25

Status: complete. Implementation, deterministic acceptance, DeepSeek API-key acceptance, and Codex ChatGPT acceptance all pass.

## Requirement audit

| Requirement | Current evidence | Result |
| --- | --- | --- |
| Registry, descriptor/capability discovery, status/auth/logout, start/resume/cancel/dispose | `agent-runtime` registry tests; direct Harness conformance; Codex auth/browser/device/logout/cancel tests | Pass |
| Model and reasoning selection | provider/pinned model catalogs, M12 negotiation, exact wire model/effort tests, unsupported config rejected before provider execution | Pass |
| Same normalized text/tool/usage/terminal semantics | shared fake fixture asserts identical semantic projections and generated Codex `ClientRequest` schema | Pass |
| Harness stays behind the pinned bridge | boundary/upstream checks; `dsh-v0.1.0-rc.7@99f6f02fecdb`; bridge 8-test lifecycle/conformance suite | Pass |
| API key remains main-process/OS-secret-owned | Electron `safeStorage` encrypted record, environment migration/deletion, logout deletion, malformed/unavailable encryption fail closed | Pass |
| Codex fixed local stdio App Server | `@openai/codex 0.148.0`, initialize/initialized, strict config, sanitized environment, Node-mode Electron child, generated schema fixture | Pass |
| No shell/file/network/patch capability | read-only sandbox, empty workspace roots/environments/MCP, disabled feature set, protocol denial for every built-in effect, distinct `codex-builtin` approval domain | Pass |
| Question and Studio approval remain separate | structured `requestUserInput` mapping; built-in effect requests auto-denied; editor tool approval remains in Studio tool runtime | Pass |
| Provider failures always become terminal | 401/429/503, RPC timeout, malformed JSON/frame/delta/usage/terminal, duplicate IDs, process crash and oversized events | Pass |
| Cancel race cannot accept late results | pending tool/question RPCs are turn-owned, cleared/rejected at terminal; late tool result is rejected | Pass |
| Session reuse cannot retain a stale tool allowlist | deterministic tool-set digest bound to Harness session and Codex thread; drift rejected before provider execution | Pass |
| Temporary process resources are released | child shutdown is idempotent; generated temporary cwd is containment-checked and recursively removed, including nested files | Pass |
| Usage/cache/rate limits are normalized | delta/cumulative usage conformance, unknown cache evidence preserved as `null`, rate-limit schema validation, 22-test usage/accounting runtime suite | Pass |
| Operation Log excludes raw text/arguments/credentials | normalized events log digests/provenance and safe usage only; context/bug-bundle canary tests; Codex environment and encrypted credential-record canaries | Pass |
| Current DeepSeek real account acceptance | User-authorized `deepseek-real.smoke.mjs`: configured fixed Harness backend, normalized conversation/usage events, `completed` terminal, `credentialPersisted=false` | Pass |
| Current Codex ChatGPT acceptance | User-authorized `codex-real.smoke.mjs`: ready ChatGPT auth, `gpt-5.6-sol` at `low`, 2 rate-limit buckets; exact text, one dynamic tool round-trip and one structured question completed; cancel ended `cancelled` | Pass |

## Completed deterministic gates

- `@haiyue/ai-studio-agent-backends`: 18/18, including direct Harness auth/logout/tool-result/cancel/unsupported-capability/dispose conformance and Codex cleanup after transport-dispose failure.
- `@haiyue/ai-studio-agent-runtime`: 22/22.
- `@haiyue/ai-studio-harness-bridge`: 8/8.
- `@haiyue/ai-studio-game-authoring-tools`: 13/13.
- AIStudio non-Electron tests: 22/22; AIStudio production build passed.
- Root `npm run check`: contracts (35 schemas, 33 valid and 22 rejection fixtures), TypeScript, boundaries, upstream pin/schema and protocol spike passed.
- Real DeepSeek Harness smoke: passed with `completed` terminal, normalized usage, no persisted credential.
- Real Codex ChatGPT smoke: passed text/tool/question/cancel with expected terminal states and exact call counts.

Every G07 requirement and both non-mock acceptance rows now have current passing evidence.
