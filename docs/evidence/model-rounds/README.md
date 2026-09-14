# Model rounds in the execution graph

Previously every user/assistant message and tool batch within a provider turn was
projected beneath one node labelled “模型处理请求”. A task can make several tool
round trips in that same turn, so the label hid the actual execution progression.

The product projection retains the authoritative turn as an “执行阶段” container
and creates separately numbered model rounds from durable turn starts, tool-batch
boundaries, responses and terminal records. Batches remain intact, including their
parallel tools. Each round owns its tool/evidence/result branch; assistant transcript
entries locate their own round. IDs use source operation identities and remain
deterministic on replay, including approval continuation across sessions.

Model rounds describe observable tool/response phases, **not provider-internal HTTP
request counts** or inferred token usage. No new provider events, accounting records,
Document mutations or second durable task envelope are introduced. Legacy histories
use the same projection without migration. The existing source-operation details
remain available for inspecting the underlying facts.

The active frontier highlights the current model round, concurrent tools or waiting
human barrier. A failed tool does not relabel completed model output as failed.
Terminal turn reasons are retained, late checkpoint answers cannot restart a closed
round, and resolved approvals update historical summaries.

Validation: 59 shell tests, four durable context/tool-batch integration tests and the
isolated Electron window test passed. The latter covers three model rounds, tools,
approval/continuation beams, terminal cleanup, narrow layout, keyboard navigation
and a 1000-tool graph. Desktop build passed; the user's running app was not restarted.

The root check ran with `--ignore-scripts` to reuse already-built dependencies while
running the check script's actual gates. Contracts, type checks, boundaries, upstream,
candidates, protocol and M12 quick checks passed. It stopped at the existing M14
capability evidence input-digest mismatch; milestone evidence was not rewritten.
