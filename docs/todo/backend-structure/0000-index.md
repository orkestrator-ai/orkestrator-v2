# Backend structure

Refactors of the backend's internal structure: storage repositories, the native agent service, runtime state ownership, domain folders and the Claude bridge prompt stream.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0930-storage-test-files-over-size-limit.md](0930-storage-test-files-over-size-limit.md) | Low | Yes | The four storage test files that were over 2,000 lines (`src/core/storage.test.ts`, `tests/storage.test.ts`, `storage-writer-guards.test.ts`, `storage-agent-mail.test.ts`) are split by subject as pure moves, and the writer guard's raw-writer scan parses only the files it can need, with identical results, which resolves flake 1309. Follow-up from 0214. Kept until the branch merges for its decisions, then deleted. | Every item is done; nothing remains to leave undone. |
| 2 | [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md) | Medium | No | Move `apps/backend/src/core/` prefix groups into lint-enforced domain folders, one domain per PR. | Organisational move of `core/` into lint-enforced domain folders; low risk, one domain per PR. |
| 3 | [0057-native-agent-service-size.md](0057-native-agent-service-size.md) | Low | No | Split the remaining session operations out of `NativeAgentService` (3,880 lines) and the two read models out of `NativeAgentTranscriptProjection` (5,303 lines). Follow-up from 0010. | Size and readability only: the state is already in collaborators, so leaving the files large changes no behaviour and carries no ordering risk. |
| 4 | [0390-backend-module-state-beyond-0133.md](0390-backend-module-state-beyond-0133.md) | Low | No | Module state 0133 did not list: agent-account logins, usage caches and the mutation chain, container login pushes and MCP digests, the plan-usage cache's active account, GitHub CLI and OpenCode provider logins, OpenCode command journals and a registered config loader; plus three test seams and three possibly process-wide bounds to decide. Follow-up from 0133. | Production runs one backend per process, so leaving it changes no behaviour; it only keeps two backends in one test from being fully isolated. |
| 5 | [0733-two-backends-share-process-watchers.md](0733-two-backends-share-process-watchers.md) | Low | Yes | The container log service is now `runtime.containerLogs`, stopped only with its own backend; the OOM follower and the three login refreshers had already moved in 0133. `backend-runtime.test.ts` runs two `OrkestratorBackend`s at once, shuts one down and shows the other keeps its OOM counts, log subscriptions and login refreshers. Kept until the branch merges for its decisions, then deleted. | Every item is done; nothing remains to leave undone. |
