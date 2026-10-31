# Backend module state beyond 0133

Found while doing todo 0133 (finished and deleted; its durable
description is in [`backend-runtime.md`](../../architecture/backend-runtime.md))
on `todo-0133-backend-module-state-3cc0d753a9d5` from `863b5782`
(2026-10-27). 0133 moved the rows it listed into `BackendRuntime`. A fresh scan
of `apps/backend/src/core` for module-level `let`s and `Map`/`Set` singletons
(skipping embedded worker scripts, whose state lives in their own process)
found more per-backend state that 0133 did not list. Two backends in one
process still share it. 0133 could not take new items (README rule), so it is
recorded here.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

The container log service row is done: it moved to `runtime.containerLogs` in
[0733](0733-two-backends-share-process-watchers.md) (`00f3c5dd`, #1398) and is
not repeated as a task. Nothing else in this file has moved since it was
written; every other row is still module state on `main`.

### Tasks

1. **Account state into `runtime.accounts`**: the `agent-accounts.ts`, `agent-accounts-containers.ts` and `plan-usage-cache.ts` rows, with their reset seams. Status: done.
2. **GitHub CLI login and config source**: `github-cli-setup.ts` `activeLogin` and the `github-credentials.ts` config loader. Status: done.
3. **OpenCode provider login**: `opencode-provider-login.ts` `current`, `mutation`, `listFlight`. Status: done.
4. **OpenCode command journals and probe**: `opencode-command-changes.ts` `sharedProbe`, `journals`, `removedJournalDirectories`. Status: done.
5. **Module-level test seams**: decide, per seam, construction option or documented seam. Status: done.
6. **Possibly process-wide state**: decide and document the disk-scan bound, the macro check and mail id generation. Status: done.
7. **Two-backend coverage and checks per move**: `backend-runtime.test.ts` covers each moved piece; the usual checks pass. Status: done.

### 1. Account state into `runtime.accounts`

**Problem.** Two backends in one process share one sign-in slot, one account
mutation chain, one usage cache, one plan-usage cache and one record of what
was pushed into which container. A sign-in started on one backend shows as
progress on the other.

**Context.** `AgentAccountsRuntime` (`apps/backend/src/core/agent-accounts-runtime.ts:25-62`)
already owns the last usage readings, the login refreshers and the
coordinator Keychain clears. The rows go together because they share the
mutation chain and the usage cache.

**Investigation.**
- `agent-accounts.ts:68` `accountMutation` (used by `withAccountMutation`,
  5 calls), `:342` `activeLogin`, `:692` `usageCache`, `:700`
  `usageGenerations`, and the seam `resetAgentAccountLoginForTests` at
  `:683`, used by `agent-accounts.test.ts` and
  `commands-registry-accounts.test.ts`. The usage keys include
  `accountsRoot(context)` (`:89`, `usageKey` at `:702`), so the two caches do not mix
  entries between data directories; the sign-in slot and the mutation chain
  are truly shared.
- `agent-accounts-containers.ts:714` `hostMcpRefreshDigests` with
  `resetHostMcpRefreshDigests` at `:759`, and `:959` `pushedClaudeLogins`.
  `claudeLoginHandoff(credentials)` (`:744`) takes no context; both callers
  (`:700`, `:1041`) have one.
- `plan-usage-cache.ts:149` `sharedPlanUsageCache` and `:150`
  `activeAccountIds`, set through `setActivePlanUsageAccount` (`:152`) and
  `initializeActivePlanUsageAccount` (`:156`, called from
  `agent-accounts-active.ts:50`). Both are keyed by agent only, so they are
  truly shared. Readers without a `CommandContext`:
  `http-bridge-provider.ts:160` and `http-bridge-progressive.ts:297`
  (`contextUsageWithPlanUsage`), and the module-level
  `readPlanUsage = createPlanUsageReader({ cache: sharedPlanUsageCache })`
  (`plan-usage.ts:1000`). `commands-registry.ts:297` already takes a
  `planUsageReader` option.

**Decisions.**

- **One owner or two?**
  - **Everything on `AgentAccountsRuntime`, with the plan-usage cache as a
    field (`runtime.accounts.planUsage`) (recommended).**
    - Pros: one owner for the mutation chain, both caches and the active
      account, which change together on a switch (`agent-accounts.ts:195-218`);
      matches how `lastUsage` is held.
    - Cons: the bridge providers have no context, so the cache must be
      passed into their dependencies; `AgentAccountsRuntime` grows.
  - **A separate `PlanUsageRuntime` on `BackendRuntime`.**
    - Pros: plan usage is read by bridges as well as accounts; a narrower
      thing to pass into the providers.
    - Cons: a switch then touches two owners in one step.
- **How do the readers without a context reach the cache?**
  - **Pass the owner's narrow cache into the HTTP bridge provider's
    dependencies, and build `readPlanUsage` per runtime instead of at module
    load (recommended).**
    - Pros: follows the backend-runtime rule (pass the narrow cluster down);
      `commands-registry.ts` already accepts a reader.
    - Cons: touches the provider construction path.
  - **Keep `sharedPlanUsageCache` process-wide and document it.**
    - Pros: no plumbing.
    - Cons: it is keyed by agent only, so one backend's active account would
      filter the other's session windows (`plan-usage-cache.ts:219`).

### 2. GitHub CLI login and config source

**Problem.** The GitHub CLI sign-in slot and the config loader that host `gh`
runs read are one per process. The second backend constructed overwrites the
first's loader, so the first backend's `gh` runs follow the second's selected
credential.

**Context.** The table called the loader "the registered `loadGlobalConfig`".
It is set by `setGitHubCliConfigSource`, not a registry.

**Investigation.**
- `github-cli-setup.ts:84` `activeLogin`, with the seam
  `resetGitHubCliSetupForTests` (`:184`), used three times in
  `github-cli-setup.test.ts`.
- `github-credentials.ts:56` `loadGlobalConfig`, set by
  `setGitHubCliConfigSource` (`:59`) from `index.ts:530`
  (`async () => (await storage.loadConfig()).global`) and read by
  `gitHubCliEnv` (`:74-75`). `gitHubCliEnv` has 10 production callers in 7
  modules (`agents-md-pr.ts`, `commands-pr-monitor.ts`,
  `commands-projects.ts`, `commands-review.ts`, `github-clone-browser.ts`,
  `github-git-credentials.ts` and `github-credentials.ts`). Three test
  files set the loader.

**Decisions.**

- **Where does the sign-in slot live?**
  - **A `GitHubCliLoginSlot` on `runtime.localServers`, shaped like
    `cursorSdkLogin` (`CursorSdkLoginSlot`) (recommended).**
    - Pros: an existing pattern for exactly this (one in-flight sign-in per
      backend); the test seam becomes a fresh runtime.
    - Cons: `gh auth login` writes the host user's `gh` config, so two
      backends could still race on the file; the slot only isolates
      progress.
  - **Document it as process-wide.**
    - Pros: matches the one host `gh` config.
    - Cons: one backend sees and can cancel the other's sign-in.
- **How does `gitHubCliEnv` get the config?**
  - **Callers pass the global config, or a loader from their context, as an
    argument; drop the setter (recommended).**
    - Pros: no hidden registration; every caller has a context or storage in
      reach.
    - Cons: ten call sites change.
  - **A construction option on a runtime owner (`runtime.github.loadConfig`).**
    - Pros: fewer signatures change if callers already hold the runtime.
    - Cons: `github-git-credentials.ts` and `github-clone-browser.ts` do not
      all hold a context today, so some plumbing remains anyway.

### 3. OpenCode provider login

**Problem.** The OpenCode provider sign-in, its mutation token and the
provider list single flight are module state, so two backends share one
sign-in and one listing.

**Context.** `createOpenCodeProviderLogin(overrides)` (`opencode-provider-login.ts:289`)
is already a factory, but the functions it returns close over the module
variables rather than their own.

**Investigation.** `opencode-provider-login.ts:264-266` `current`,
`mutation`, `listFlight`; the module singleton
`openCodeProviderLogin = createOpenCodeProviderLogin()` at `:511`; the seam
`__testing.reset()` at `:513-520`, used by `opencode-provider-login.test.ts`.
All six command handlers are in `commands-registry-accounts.ts:198-234`;
`submitCode` and `cancel` take no context today, though the registry passes their handlers one.

**Decisions.**

- **Where does the login live?**
  - **Move the three variables into the factory's closure and hold one
    instance per backend on `runtime.localServers` (`openCodeProviderLogin`)
    (recommended).**
    - Pros: smallest change, since the factory and its dependency overrides
      exist; the sign-in runs against the host OpenCode server, which
      `localServers` already owns; `__testing.reset()` goes.
    - Cons: `localServers` grows by one more member.
  - **A separate class on `runtime.accounts`.**
    - Pros: groups it with the other sign-ins.
    - Cons: the server it talks to is a `localServers` concern, so the
      class would need that cluster too.

### 4. OpenCode command journals and probe

**Problem.** The shell-change probe and the per-file journal map are process
singletons.

**Context.** The probe's comment says it is "one probe per backend process"
on purpose: its snapshot queue is per repository, so two providers on one
worktree must share it (`opencode-command-changes.ts:110-120`).

**Investigation.** `opencode-command-changes.ts:110` `sharedProbe`, `:123`
`journals`, `:124` `removedJournalDirectories`. Journal files live under
`openCodeCommandChangeJournalDirectory(dataDir, environmentId)` (`:142-147`),
and `removeOpenCodeCommandChangeJournals` (`:150-165`) is called with
`storage.getDataDir()` (`commands-servers.ts:1517`). Both maps are therefore
keyed by a path inside the backend's data directory: two backends with
different data directories never share an entry. The providers reach the
journals through `opencode-provider-environment.ts:33-40`, which has the
environment's `dataDir` but no runtime. `removedJournalDirectories` is never
pruned, so it grows by one entry per deleted OpenCode environment for the life
of the process.

**Decisions.**

- **Move, or document?**
  - **Document all three as process-wide on purpose in
    `backend-runtime.md`: the probe serialises snapshots per repository on the
    host, and the journal maps are keyed by data-directory paths (recommended).**
    - Pros: no plumbing through the native-agent provider environment; the
      state is already isolated per backend by its keys.
    - Cons: departs from this file's original plan to move every row; the
      removed-directory set still lives as long as the process.
  - **Move the journals onto a per-backend owner, passed through
    `NativeAgentProviderEnvironment`, and keep the probe process-wide.**
    - Pros: the journals and the removed set end with their backend.
    - Cons: a new field on the shared provider environment for state that
      cannot collide today.

### 5. Module-level test seams

**Problem.** Three setters remain at module level, against the backend-runtime
rule that test seams are construction options.

**Context.** The rule is in
[`backend-runtime.md`](../../architecture/backend-runtime.md) ("Test seams are
construction options, not setters").

**Investigation.**
- `agent-skills.ts:127` `homeOverride` via `setAgentSkillsHomeForTesting`
  (`:129`). It exists because `os.homedir()` ignores `$HOME` under Bun, and
  mirrors `setClaudeHomeForTesting` in the Claude bridge. It is used by
  `tests/command-fixtures.ts:196`, `:1545`, `:1654` and three test files.
- `container-storage.ts:187` `testVolumeDriverOptions` via
  `setStorageVolumeOptionsForTest` (`:189`). Its only caller is the live
  disk-exhaustion case in `tests/container-live-replacement.test.ts:534-562`.
  No command reaches it.
- `agent-test-cursor-credential.ts:25` `hostCursorCredential` is not a test
  seam: it is the Cursor key snapshot an agent-test profile runs on, loaded
  once per process by `loadAgentTestHostCursorApiKey` from `main.ts:58`. It is
  read by `resolveCursorCredential` (`:55`), whose callers
  (`commands-validation.ts:191` `resolveCursorApiKey`, with 6 callers, and
  `cursor-sdk-bridge.ts:49`) take no runtime.

**Decisions.**

- **`agent-skills.ts` home override.**
  - **Keep it as a documented test-only seam (recommended).**
    - Pros: the home directory is a property of the process; the Claude
      bridge uses the same seam; no production signature changes.
    - Cons: breaks the "construction options" rule; every test must reset it.
  - **A construction option (a home on the runtime or the command fixtures).**
    - Pros: follows the rule.
    - Cons: every skills lookup then needs the runtime for a value that is
      `os.homedir()` in production.
- **`container-storage.ts` volume driver options.**
  - **Keep it as a documented test-only seam (recommended).**
    - Pros: one live failure-injection test; it changes volumes on the
      daemon, not backend state.
    - Cons: as above.
  - **A construction option on `BackendRuntime`.**
    - Pros: follows the rule.
    - Cons: public construction surface for one live test.
- **`agent-test-cursor-credential.ts` key snapshot.**
  - **Document it as process-wide on purpose: the process entry loads it once
    from its own data directory (recommended).**
    - Pros: true to how it is loaded; no plumbing into seven callers.
    - Cons: a test that runs two agent-test backends in one process would
      see one key.
  - **A backend construction option held on `runtime.localServers`.**
    - Pros: per backend.
    - Cons: `resolveCursorApiKey(global)` and its callers would all need the
      runtime.

### 6. Possibly process-wide state

**Problem.** Three pieces of state may be process-wide on purpose, but none is
documented as such.

**Context.** 0133 recorded its process-wide choices in the "Process-wide on
purpose" table of `backend-runtime.md` and next to each declaration.

**Investigation.**
- `disk-usage.ts:68-69` `running` and `waiting` bound disk scans at
  `MAX_CONCURRENT_MEASUREMENTS = 2` (`:23`), through `limited` (`:107`,
  `:241`). This is the same kind of host bound as `gitDockerScanPool`.
- `transcript-artifacts/interactive-modules.ts:208` `macroCheck` proves
  "once per process" that this Bun honours `macros: false` (`:210-231`). It
  is a fact about the runtime, and a failure clears it.
- `storage-agent-mail.ts:81`, `:83` `lastIdTime` and `idSequence`, used only
  by `sortableId` (`:90-99`) from inside `AgentMailRepository` (`:532`).
  Ids sort by a clock that never runs backwards, then a sequence.

**Decisions.**

- **Which stay process-wide?**
  - **All three stay, each marked next to its declaration and added to the
    "Process-wide on purpose" table (recommended).**
    - Pros: the disk bound would double with a pool per backend; the macro
      check describes the Bun runtime; a process-wide id clock is monotonic
      across every repository in the process, a stronger guarantee than one
      per repository, and shares nothing but ordering.
    - Cons: none in behaviour; the table grows by three rows.
  - **Move the mail id clock onto `AgentMailRepository`.**
    - Pros: one less module variable.
    - Cons: two repositories on one database in one process (tests) could
      then interleave ids within one millisecond.

### 7. Two-backend coverage and checks per move

**Problem.** A move is only proved when two backends in one process are shown
not to share the moved piece.

**Context.** `backend-runtime.test.ts` has "two BackendRuntimes in one process"
(`:86`), including "the Cursor SDK login and agent-account state are per
backend" (`:562`), and "two OrkestratorBackends in one process (todo 0733)"
(`:681`).

**Investigation.** None of the rows in tasks 1 to 4 has a case yet.

**Decisions.**

- **Which harness proves each move?**
  - **A `BackendRuntime`-level case per move, extending `:562` for task 1;
    the full-backend case at `:681` only where the backend's own wiring
    sets the state (the GitHub config source, task 2) (recommended).**
    - Pros: fast and direct; the full-backend case is kept for wiring that
      only `OrkestratorBackend` does.
    - Cons: two harnesses to keep in step.
  - **Only the full-backend case.**
    - Pros: one place proves everything.
    - Cons: slower, and a failure points less clearly at the owner.
- **What counts as a pass?** `mise run format:check`, `mise run lint`,
  `mise run typecheck` and `mise run test` for each move, as the file says.
  `mise run test` has had the production backend SIGKILLed on this host (see
  AGENTS.md); run it in a quiet window and record any unrelated failure
  against a base-commit rerun.

## Current state

Every row this file listed has moved or is documented; see Assumptions and
decisions. The line references in the task subsections are from `79f3bc97` and
have moved. Module state this file did not list is in
[1070-backend-module-state-beyond-0390.md](1070-backend-module-state-beyond-0390.md).

The container log service (`container-log-service.ts` `instance`) moved to
`runtime.containerLogs` in
[0733-two-backends-share-process-watchers.md](0733-two-backends-share-process-watchers.md).

## Constraints and rationale

The same as 0011, 0066 and 0133: one class per owner with private state,
reached through `context.runtime` at call time, never destructured at module
load; timers are cleared by the owner's `shutdown()`. Production runs one
backend per process, so none of this changes shipped behaviour.

## Needs verification

None. Production runs one backend per process and this file changes no behaviour there; the two-backend cases in `backend-runtime.test.ts` are the proof.

## Assumptions and decisions

Checked against `main` at `931e5541` before starting. Every row was still module state; only line numbers had moved, and `gitHubCliEnv` had grown to 12 production calls in 8 modules (`bug-report-service.ts` and `graph-system-environment.ts` joined).

### Task 1: one owner, with the plan-usage cache as a field

Followed the recommendation. `AgentAccountsRuntime` owns the mutation chain, the sign-in, per-account usage, its generations, container login pushes and the MCP digests. `runtime.accounts.planUsage` (`PlanUsageState`) holds the cache and active account, and `runtime.accounts.readPlanUsage` is the reader built over it. `readProjectUsageLimits` now requires its `planUsage` source, so the module default went with the singleton.

### Task 1: session reports reach the cache through provider dependencies

Followed the recommendation. `planUsage` is an optional member of `HttpBridgeProviderDependencies`, because tests and `createNativeAgentProvider(connection)` build providers with no backend behind them; such a provider only normalizes its reports. All production construction paths pass it: `NativeAgentService` (three sites), the build pipeline, Multi Review, the graph providers, feature planning and retired Looped Review cleanup. The non-native paths matter only for Cursor: their connections carry no `accountId`, so Claude and Codex reports were already filtered out there. They are wired anyway so behaviour stays identical.

### Task 2: a sign-in slot, and storage as the config source

Followed both recommendations. `GitHubCliLoginSlot` sits on `runtime.localServers`, shaped like `CursorSdkLoginSlot`. `gitHubCliEnv` takes a `GitHubCliConfigSource`, satisfied by `StorageService`, rather than a config value, so the config is still read per run. The parameter is required but may be `undefined`, which means the host login: the same result as the old unset loader, and each site has to state it. `detectEnvironmentPullRequest` reuses its existing optional `storage`, which both local callers pass; its container branch runs no host `gh`. `createGitEnvironmentCommandRunner` is the default for the three stores that only run Git, so they need no credential.

### Task 3: state on a slot, not in the factory's closure

Departed from the recommendation. `local-server-runtime.ts` cannot hold an instance of `createOpenCodeProviderLogin`: `opencode-provider-login.ts` imports `host-model-catalog-refresh.ts`, which imports `commands-containers.ts`, which imports `local-server-runtime.ts`, and `import/no-cycle` is a lint error. So `OpenCodeProviderLoginSlot` holds the three variables on `runtime.localServers`, the same shape as the Cursor and GitHub slots, and the factory reads it from the context at call time. The factory keeps its dependency overrides, and `submitCode` and `cancel` now take a context. `__testing.reset()` is gone. `openCodeProviderLogin` stays a module constant, holding only production dependencies.

### Task 4: document, do not move

Followed the recommendation. Read and confirmed: the probe orders snapshots per repository, and both journal maps are keyed by paths inside a data directory. All three are marked next to their declarations and in the table, including that the removed set grows by one entry per deleted OpenCode environment.

### Task 5: keep two seams, document one snapshot

Followed the three recommendations. `homeOverride` and `testVolumeDriverOptions` stay as documented test-only seams, and `hostCursorCredential` is documented as process-wide.

### Task 6: all three stay process-wide

Followed the recommendation for the disk-scan bound, the macro check and the mail id clock.

### Task 7: no full-backend case for the GitHub config source

Departed from the recommendation. It kept the full-backend case for the backend's own wiring, but task 2 removed that wiring, so `index.ts` sets nothing to prove. Instead a `BackendRuntime`-level case runs `list_github_clone_accounts` through one registry against two contexts and checks the `GH_TOKEN` each `gh` run gets. A full-backend case would also run the real host `gh`, because `OrkestratorBackend` has no seam for that command.

### Follow-up: 1070

The scan for this file's rows found about twenty more modules with unlisted module state. They were out of scope, so they are recorded unread in [1070-backend-module-state-beyond-0390.md](1070-backend-module-state-beyond-0390.md).

## Related

- [0733-two-backends-share-process-watchers.md](0733-two-backends-share-process-watchers.md): moved the container log service row.
- [1070-backend-module-state-beyond-0390.md](1070-backend-module-state-beyond-0390.md): module state this file did not list.
- [`backend-runtime.md`](../../architecture/backend-runtime.md)
