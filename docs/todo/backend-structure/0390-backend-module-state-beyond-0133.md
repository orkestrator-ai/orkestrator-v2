# Backend module state beyond 0133

Found while doing
[0133-backend-module-state-beyond-0066.md](0133-backend-module-state-beyond-0066.md)
on `todo-0133-backend-module-state-3cc0d753a9d5` from `863b5782`
(2026-10-27). 0133 moved the rows it listed into `BackendRuntime`. A fresh scan
of `apps/backend/src/core` for module-level `let`s and `Map`/`Set` singletons
(skipping embedded worker scripts, whose state lives in their own process)
found more per-backend state that 0133 did not list. Two backends in one
process still share it. 0133 could not take new items (README rule), so it is
recorded here.

## Current state

Per-backend state: logins, caches and chains that belong to one backend and
should follow the 0011/0066/0133 pattern.

| Module | State | Likely owner |
| --- | --- | --- |
| `agent-accounts.ts` | `accountMutation` (the account mutation chain), `activeLogin`, `usageCache`, `usageGenerations`, and the `resetAgentAccountLoginForTests` seam | `runtime.accounts` (`AgentAccountsRuntime`) |
| `agent-accounts-containers.ts` | `hostMcpRefreshDigests` (with `resetHostMcpRefreshDigests`), `pushedClaudeLogins` | `runtime.accounts` |
| `plan-usage-cache.ts` | `activeAccountIds` (`setActivePlanUsageAccount`) and `sharedPlanUsageCache` | `runtime.accounts`, or a plan-usage class on `BackendRuntime` |
| `github-cli-setup.ts` | `activeLogin` | `runtime.localServers` or a GitHub owner |
| `opencode-provider-login.ts` | `current`, `mutation`, `listFlight` | `runtime.localServers` |
| `container-log-service.ts` | `instance` (`ContainerLogService`, stopped by `shutdownContainerLogService`) | `BackendRuntime`, started and stopped with the backend |
| `opencode-command-changes.ts` | `sharedProbe`, `journals`, `removedJournalDirectories` | `runtime.localServers` or a change-tracking owner |
| `github-credentials.ts` | the registered `loadGlobalConfig` | a construction option |

Test seams still at module level: `agent-skills.ts` `homeOverride`
(`setAgentSkillsHomeForTesting`), `container-storage.ts`
`testVolumeDriverOptions`, `agent-test-cursor-credential.ts`
`hostCursorCredential`. Decide whether each becomes a construction option or
stays a documented test-only seam.

Possibly process-wide (decide and document, as 0133 did):
`disk-usage.ts` `running`/`waiting` (a concurrency bound on disk scans),
`transcript-artifacts/interactive-modules.ts` `macroCheck`,
`storage-agent-mail.ts` `lastIdTime`/`idSequence` (mail id generation).

## Outstanding work

### Code

1. Decide, per possibly-process-wide entry above, whether it moves or stays;
   record the choice next to the state.
2. Move each per-backend row into its owner behind methods, with no
   `set*`/`reset*` seams; tests construct the runtime with options instead.
   The `agent-accounts*.ts` rows go together (they share the mutation chain
   and usage cache).
3. Extend `backend-runtime.test.ts` so the two-backend test covers each moved
   piece.

### Qualification

- `mise run format:check`, `mise run lint`, `mise run typecheck`,
  `mise run test` for each move.

## Assumptions and decisions

None yet.

## Needs verification

None yet.

## Constraints and rationale

The same as 0011, 0066 and 0133: one class per owner with private state,
reached through `context.runtime` at call time, never destructured at module
load; timers are cleared by the owner's `shutdown()`. Production runs one
backend per process, so none of this changes shipped behaviour.

## Related

- [0133-backend-module-state-beyond-0066.md](0133-backend-module-state-beyond-0066.md)
- [0066-backend-residual-module-state.md](0066-backend-residual-module-state.md)
- [`backend-runtime.md`](../../architecture/backend-runtime.md)
