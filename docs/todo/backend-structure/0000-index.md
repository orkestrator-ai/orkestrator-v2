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
| 1 | [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md) | Medium | backlog | — | Move `apps/backend/src/core/` prefix groups into lint-enforced domain folders, one domain per PR (`design` and `http-bridge` done). | Organisational move of `core/` into lint-enforced domain folders; low risk, one domain per PR. |
| 2 | [0057-native-agent-service-size.md](0057-native-agent-service-size.md) | Low | backlog | — | Split the remaining session operations out of `NativeAgentService` (3,880 lines) and the two read models out of `NativeAgentTranscriptProjection` (5,303 lines). Follow-up from 0010. | Size and readability only: the state is already in collaborators, so leaving the files large changes no behaviour and carries no ordering risk. |
| 3 | [7490-move-codemod-rewrites-revision-paths.md](7490-move-codemod-rewrites-revision-paths.md) | Low | backlog | — | Stop `scripts/move-backend-modules.ts` rewriting `<revision>:<path>` strings that name a file at an older commit. Follow-up from 0012. | Tooling only: each domain-folder slice reverts these by hand until it is done; nothing at runtime depends on it. |
| 4 | [7543-effect-adoption-follow-ups.md](7543-effect-adoption-follow-ups.md) | Low | blocked | Waits on: a parked-cancel or prompt-timeout bug recurring in a bridge (task 5). | What the 2026-11-07 Effect review left: the registered error codes, renderer display, backend timing helpers and bridge bounded wait are done (2026-11-10), and the content, media, MCP read and command invoker timeouts now cancel their work (2026-11-11); left is an optional Cursor parked-cancel pilot. | The defects the review found are fixed; the remainder only matters if parked-cancel bugs recur. |
