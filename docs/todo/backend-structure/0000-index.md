# Backend structure

Refactors of the backend's internal structure: storage repositories, the native agent service, runtime state ownership, domain folders and the Claude bridge prompt stream.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0009-storage-service-repositories.md](0009-storage-service-repositories.md) | Medium | No | Replace the `StorageService` inheritance chain with per-store repositories over a shared `StorageContext`, keeping the store writer guard (`storage-writer-guards.test.ts`) passing. `StorageContext` exists (step 1); the repository extractions and the chain's removal remain. Pinned by `tests/unit/inheritance-chains.test.ts`. | Splits the storage inheritance chain while keeping the single-writer guard; mistakes here risk store corruption, so it leads the refactors. |
| 2 | [0010-native-agent-service-collaborators.md](0010-native-agent-service-collaborators.md) | Medium | No | Turn the six-layer `NativeAgentService` chain into a class composed of collaborators. Pinned by `tests/unit/inheritance-chains.test.ts`. | Unwinds a six-layer inheritance chain into collaborators; it removes real ordering risk around session leases. |
| 3 | [0011-backend-runtime-state-ownership.md](0011-backend-runtime-state-ownership.md) | Medium | No | Move the remaining module-level bindings in `commands-runtime-state.ts` into `BackendRuntime` clusters and delete the test setter seams. | Module-level mutable bindings and test setter seams remain until they move into `BackendRuntime` clusters. |
| 4 | [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md) | Medium | No | Move `apps/backend/src/core/` prefix groups into lint-enforced domain folders, one domain per PR. | Organisational move of `core/` into lint-enforced domain folders; low risk, one domain per PR. |
| 5 | [0013-claude-bridge-prompt-stream-state.md](0013-claude-bridge-prompt-stream-state.md) | Medium | No | Direct tests for `createPromptStreamState`, then split its delta handler and move the plan-mode flags to `TurnState`. | The prompt stream state has no direct tests yet; the split that follows is small. |
