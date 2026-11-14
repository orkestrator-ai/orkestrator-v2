# Backend structure

Refactors of the backend's internal structure: storage repositories, the native agent service, runtime state ownership, domain folders and the Claude bridge prompt stream.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Status** says who can act on the file's open tasks and
**Needs you** names the part only the user can do
([choosing a status](../../README.md#choosing-a-status)).

| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md) | Medium | backlog | — | Move `apps/backend/src/core/` prefix groups into lint-enforced domain folders, one domain per PR (`design`, `http-bridge`, `web-annotations`, `control-mcp`, `plan-usage` and `features` done; `keyed-record-format.ts` placed in the kernel). | Organisational move of `core/` into lint-enforced domain folders; low risk, one domain per PR. |
| 2 | [0057-native-agent-service-size.md](0057-native-agent-service-size.md) | Low | backlog | — | Split the two read models out of `NativeAgentTranscriptProjection` (6,347 lines); the session operations, dispatch and mail injection are already out of `NativeAgentService` (now 3,088 lines). Follow-up from 0010. | Size and readability only: the state is already in collaborators, so leaving the files large changes no behaviour and carries no ordering risk. |
| 3 | [7543-effect-adoption-follow-ups.md](7543-effect-adoption-follow-ups.md) | Low | blocked | Waits on: a parked-cancel or prompt-timeout bug recurring in a bridge (task 5). | What the 2026-11-07 Effect review left: the registered error codes, renderer display, backend timing helpers and bridge bounded wait are done (2026-11-10), and the content, media, MCP read and command invoker timeouts now cancel their work (2026-11-11); left is an optional Cursor parked-cancel pilot. | The defects the review found are fixed; the remainder only matters if parked-cancel bugs recur. |
