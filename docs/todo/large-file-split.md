# Large file split — analysis and follow-up

Status: source and corresponding test splits complete on 2026-08-16. The
remainder of this document preserves the analysis and constraints used for the
test split.

Branch: `split-large-modules`. Four commits against `bd78829`:

| Commit | What it did |
| --- | --- |
| `f1306e5` | Split 19 oversized modules into 140 focused ones |
| `46a9fe2` | Restored type safety in the split layers (removed `[key: string]: any`) |
| `de8dc92` | Replaced namespace-snapshot destructures; broke 12 of 18 import cycles |
| `ff98e28` | Eliminated the remaining cycles; backend and bridges are now acyclic |

Verified at `ff98e28`: backend/web/desktop typechecks pass, `bun run test`
passes (3,709 pass, 1 skip, 0 fail), forced desktop build passes, and
`tests/unit/module-import-cycles.test.ts` reports zero cycles.

---

## 1. What was split

Every original file became a thin barrel that re-exports the new modules, so
**no import path outside these groups changed**. That is what allowed the source
split to land without touching a single test assertion — and it is also why the
tests are now badly mismatched to the code they cover.

Module counts are as of `ff98e28` and exclude files that predate the split
(`gateway-event-replay.ts`, `opencode-model-preferences.ts`).

### Backend

| Original | Lines | Became |
| --- | ---: | --- |
| `apps/backend/src/core/commands.ts` | 14,616 | 5-line barrel + 38 `commands-*.ts` modules |
| `apps/backend/src/core/storage.ts` | 8,536 | 5-line barrel + 12 `storage-*.ts` modules |
| `apps/backend/src/gateway.ts` | 4,702 | 5-line barrel + 9 `gateway-*.ts` modules |
| `apps/backend/src/core/native-agent-service.ts` | 4,815 | 2-line barrel + 7 `native-agent-service-*.ts` modules |
| `apps/backend/src/core/tmux.ts` | 4,325 | 7-line barrel + 9 `tmux-*.ts` modules |
| `apps/backend/src/core/build-pipeline-service.ts` | 3,493 | 7-line barrel + 5 `build-pipeline-service-*.ts` modules |

### Bridges

| Original | Lines | Became |
| --- | ---: | --- |
| `bridges/claude-bridge/src/services/session-manager.ts` | 7,308 | 8-line barrel + 9 `session-manager-*.ts` modules |
| `bridges/acp-bridge/src/index.ts` | 5,045 | barrel + 11 `acp-*.ts` modules |
| `bridges/codex-bridge/src/app-server-runtime.ts` | 5,002 | 10-line barrel + 6 `app-server-runtime-*.ts` modules |
| `bridges/acp-bridge/src/testing/fake-agent.ts` | 3,831 | entry + 7 `fake-agent-*.ts` modules |

### Renderer

| Original | Lines | Became |
| --- | ---: | --- |
| `apps/web/src/lib/backend.ts` | 3,161 | 7-line barrel + 8 `lib/backend/*.ts` modules |
| `apps/web/src/lib/opencode-client.ts` | 2,971 | 5-line barrel + 5 `lib/opencode-*.ts` modules |
| `components/claude/ClaudeTmuxChatTab.tsx` | 3,185 | `ClaudeTmuxChatTab.tsx` (1,559) + `.parts.tsx` (1,669) |
| `components/layout/ActionBar.tsx` | 2,722 | 1-line barrel + `.view.tsx` (1,512) + `useActionBarController.ts` (1,499) + `.types.ts` |
| `components/chat/NativeMessage.tsx` | 2,601 | barrel + `.renderer`/`.agent-parts`/`.basic-parts`/`.file-parts`/`.shared` |
| `components/terminal/TerminalContainer.tsx` | 2,431 | barrel + `.view.tsx` (1,942) + `.helpers.ts` + `TerminalContainerOverlays.tsx` |
| `components/native-agent/AgentNativeTab.tsx` | 2,347 | barrel + `.controller.tsx` (1,641) + `.helpers.tsx` |
| `components/layout/AgentInfoButton.tsx` | 2,286 | `AgentInfoButton.tsx` (1,718) + `.panels.tsx` (594) |
| `components/settings/GlobalSettings.tsx` | 2,256 | `GlobalSettings.tsx` (120) + `.sections.tsx` (1,705) |

---

## 2. Structural rules the split established

A test-splitting agent has to respect these; several of them decide whether a
given test *can* be moved to a narrower file at all.

### 2.1 Two different split shapes

**Function modules** — `commands-*`, `tmux-*`, `acp-*`, `opencode-*`,
`lib/backend/*`, `fake-agent-*`, `session-manager-*`. These export free
functions. A split test can import the narrow module directly, e.g.
`import { getHostPort } from ".../commands-container-exec.js"`.

**Layer chains** — `StorageService`, `NativeAgentService`, `BuildPipelineService`,
`OrkestratorGateway`, `AppServerRuntime`. These are one class split across
`extends` layers. **Every intermediate layer is `abstract` and cannot be
instantiated**, so a split test still has to construct the concrete facade from
the barrel. The layers are a code-organisation boundary, not a test seam:

```
StorageBase → StorageProjects → StorageConfig → StorageSessions → StorageReviews
  → StorageNative → StoragePrompts → StorageDrafts → StorageKanban → StorageService

NativeAgentServiceBase → …Dispatch → …Projection → …Prompt → …Reconciliation
  → NativeAgentServiceProvider (exported as NativeAgentService)

BuildPipelineServiceBase → …Supervisor → …Recovery → …Interactions → BuildPipelineService

GatewayBase → GatewayEvents → GatewayAuth → GatewayHandlers → GatewayProxy
  → OrkestratorGateway

AppServerRuntimeBase → …Lifecycle → …Sessions → …Prompt → …Tail → AppServerRuntime
```

Split these test files **by subject**, not by layer file — one test file per
behavioural area, all constructing the same facade.

### 2.2 Leaf modules created to keep the graph acyclic

These hold shared primitives that would otherwise be back-edges. They are the
easiest, highest-value targets for genuinely isolated unit tests, and several
currently have no direct coverage of their own:

| Leaf | Lines | Holds |
| --- | ---: | --- |
| `commands-container-exec.ts` | 104 | `dockerExec`, `getDockerStatus`, `isContainerRunning`, `getHostPort`, docker state cache |
| `commands-local-server-lifecycle.ts` | 252 | local agent-server process lifecycle, baseline commit |
| `commands-server-health.ts` | 170 | HTTP health/reachability probes, bridge auth headers |
| `commands-project-files.ts` | 83 | configured project-file staging |
| `commands-error-text.ts` | 119 | bounded error text, lifecycle error classification |
| `acp-persist-writer.ts` | 146 | bounded state-file writer + coalescing persist scheduler |

### 2.3 Barrels tests currently import through

`commands.ts`, `storage.ts`, `tmux.ts`, `native-agent-service.ts`,
`build-pipeline-service.ts`, `gateway.ts`, `lib/backend.ts`,
`lib/opencode-client.ts`, `session-manager.ts`, `app-server-runtime.ts`,
`commands-helpers.ts`, `storage-shared.ts`, `tmux-session.ts`, `tmux-manager.ts`.

Prefer importing the narrow module in a split test. Importing the barrel still
works and pulls in the whole group — fine for facade tests, wasteful for a
focused one.

### 2.4 Invariants with dedicated guards — do not break these

- **`tests/unit/module-import-cycles.test.ts`** asserts the backend and all three
  bridges are acyclic. A new test file cannot create a cycle (tests are excluded
  from the scan), but if you move production code while splitting tests, this
  will catch it.
- **`tests/unit/commands-runtime-state-load-order.test.ts`** pins the
  `await import("./commands-files.js")` inside `commands-runtime-state`. That
  lazy edge is no longer load-bearing but is still pinned; converting it back to
  a static import is a separate follow-up (see §7).
- **`tests/unit/merge-cleanup-scheduler.test.ts`** covers the one inverted
  back-edge: `commands-servers` registers the merge-cleanup scheduler with
  `commands-pr-monitor` at module scope, and requests arriving before
  registration are deferred and replayed.
- Cross-module mutable state uses **getter/setter pairs**, never a directly
  assigned `export let` (an imported `let` cannot be assigned across modules).
  Examples: `getLastTmuxOrphanSweepAt`/`setLastTmuxOrphanSweepAt`,
  `setDockerContainerStateCache`, `nextTerminalActivityGenerationValue`.
- `commands-registry-*.ts` files register commands; `commands-*.ts` files hold
  the implementations. Command-level tests belong with the registry module,
  helper-level tests with the implementation module.

---

## 3. Test inventory and mismatch

The ten historical monoliths below exceeded 2,000 lines and covered the split
sources. The split is complete; the sizes and outlines are the pre-split
baseline from `ff98e28`, while the file globs identify the current test groups.

| Test file | Lines | Tests | Covers |
| --- | ---: | ---: | --- |
| `tests/unit/electron/commands-*.test.ts` | 18,931 | 394 | 38 `commands-*` modules |
| `bridges/claude-bridge/src/services/session-manager-*.test.ts` | 12,325 | 357 | 9 `session-manager-*` modules |
| `bridges/codex-bridge/src/app-server-runtime-*.test.ts` | 9,841 | 275 | 6 `app-server-runtime-*` modules |
| `apps/backend/src/core/native-agent-service-*.test.ts` | 9,602 | 205 | 7 `native-agent-service-*` modules |
| `apps/web/src/components/terminal/TerminalContainer*.test.tsx` | 8,648 | 166 | `TerminalContainer.*` |
| `tests/unit/components/ClaudeTmuxChatTab.test.tsx` | 8,308 | 169 | `ClaudeTmuxChatTab.*` |
| `tests/unit/electron/gateway-*.test.ts` | 7,629 | 176 | 9 `gateway-*` modules |
| `bridges/acp-bridge/src/acp-*.test.ts` | 7,125 | 165 | 11 `acp-*` modules |
| `tests/unit/electron/tmux-*.test.ts` | 6,224 | 168 | 9 `tmux-*` modules |
| `apps/backend/src/core/build-pipeline-service-*.test.ts` | 5,957 | 114 | 5 `build-pipeline-service-*` modules |

The OpenCode client was also split in this change; its pre-split baseline was:
`apps/web/src/lib/opencode-*.test.ts` (5,117 / 195),
`apps/web/src/components/layout/ActionBar.test.tsx` (4,501 / 166),
`apps/web/src/components/layout/AgentInfoButton.test.tsx` (4,385),
`apps/web/src/components/chat/NativeMessage.test.tsx` (4,370) plus the separate
`tests/unit/components/NativeMessage.test.tsx` (3,252).

### 3.1 `commands-*.test.ts` — the hard one

Top-level structure:

```
     23 lines    2 tests  L130-152    resolveBrowserOpenCommand
     28 lines    2 tests  L154-181    resolveFileManagerRevealCommands
    121 lines    4 tests  L1227-1347  agent skill commands
     22 lines    3 tests  L1353-1374  async test wait helpers
 14,828 lines  325 tests  L1376-16203 Electron backend command registry   <-- the problem
      613 lines  14 tests  L6927-7539   backend-owned diff statistics (only nested describe)
    243 lines    2 tests  L16205-16447 GitHub issue commands
    989 lines   19 tests  L16449-17437 environment status and settings commands
    534 lines    5 tests  L17591-18124 storage-backed command delegation
    138 lines    4 tests  L18126-18263 pane layout commands
    111 lines    5 tests  L18265-18375 feature plan commands
    555 lines   23 tests  L18377-18931 agent extension discovery commands
```

The 325 tests in `Electron backend command registry` are almost all flat `test()`
calls, so there is no describe structure to split along. They *can* be
classified by which command each drives. Grouping every test by the
`commands.get("…")` calls in its body, and mapping each command name to the
`commands-registry-*.ts` module that registers it:

| Tests | Registry module(s) driven |
| ---: | --- |
| 88 | `commands-registry-environments` |
| 61 | `commands-registry-terminal` |
| 50 | `commands-registry-pr` |
| 37 | none — helper/unit tests, no `commands.get` |
| 16 | `commands-registry-environments` + `commands-registry-terminal` |
| 12 | `commands-registry-docker` |
| 9 | `commands-registry-servers` |
| 7 | `commands-registry-environments` + `commands-registry-pr` |
| 4 | `commands-registry-linear` |
| 4 | `commands-registry-github` |
| 3 | `commands-registry-tools` |
| 2 | `commands-registry-projects` |
| 2 | `commands-registry-docker` + `commands-registry-projects` |
| 2 | `commands-registry-pr` + `commands-registry-servers` |
| 6 | other single- or multi-module combinations (1 test each) |

234 of the 325 tests (72%) map to exactly one registry module; of the 288 that
drive a command at all, 81% do. The classifier is reproducible —
it reads `register("…")` from each `commands-registry-*.ts` and matches
`commands\.get\(\s*["']([a-z0-9_]+)["']\)` inside each test body. Two caveats:

- `commands-registry-servers.ts:351` registers ACP servers dynamically as
  `` register(`start_${acpProvider}_server`, …) ``, so `start_cursor_server` and
  `start_grok_server` do not match a literal and must be mapped by hand.
- The 37 helper tests exercise exported helpers rather than commands. Route them
  by the symbol they import, not by command name.

Multi-module tests are integration tests by nature. Put them in a
`commands-integration.test.ts` rather than duplicating them or forcing them into
one owner's file.

### 3.2 Files with usable describe structure

These split cleanly along existing top-level describes; no classification pass
needed.

**`app-server-runtime-*.test.ts`** — 25 top-level describes, largest are
`session lifecycle` (2,217 / 52), `at-most-once dispatch` (1,241 / 31),
`steering` (750 / 17), `idle detach and transparent re-attach` (660 / 18),
`models` (620 / 14), `interactive approvals` (535 / 19).

**`session-manager-*.test.ts`** — 21 top-level describes, largest are
`sendPrompt` (3,305), `background task reducer` (2,550), `session lifecycle`
(865), `rate_limit_event` (827). These map well onto
`session-manager-prompt`, `-background-tasks`, `-lifecycle`, `-core`.

**`tmux-*.test.ts`** — 13 top-level describes, largest are
`Electron tmux backend command registration` (2,800 / 56) → `tmux-commands`,
`live session read paths` (826 / 16) → `tmux-session-manager`,
`ClaudeStatePollManager` (778 / 28) → `tmux-poll`,
`interactive tmux terminal snapshots` (340 / 14) → `tmux-interactive`.

**`ActionBar.test.tsx`** — 13 top-level describes already named by concern;
`ActionBar workflow tabs` (1,927 / 76) is the only one needing a second pass.

**`opencode-*.test.ts`** — 25 top-level describes already prefixed
`opencode-client <area>`, mapping onto `opencode-messages`, `-sessions`,
`-prompts`, `-interactions`, `-types`.

**`gateway-*.test.ts`** — only two describes: `gateway terminal WebSocket`
(850 / 18) and `remote gateway` (6,255 / 158). The second needs a
classification pass like `commands-*.test.ts`; route by the gateway route or
helper each test exercises (`/__orkestrator/invoke` → `gateway-handlers`,
auth/CORS/login → `gateway-auth`, SSE/replay → `gateway-events`, proxying →
`gateway-proxy`, compression/metrics helpers → `gateway-support-*`).

**`acp-bridge/src/acp-*.test.ts`** — `waitFor` (120 / 10) plus one 6,823-line
`ACP bridge` describe; needs classification against the 10 `acp-*` modules.

**`native-agent-service-*.test.ts`** — one 9,090-line `NativeAgentService`
describe with six nested describes: `OpenCode incomplete-turn recovery`
(3,237), `startup launch reconciliation` (774), `queue draining` (701),
`bridge connections` (220), `environment renaming from the first queued prompt`
(138), `input validation` (110). The remaining ~3,900 lines sit directly under
the top describe and need classification.

---

## 4. Constraints for the test-splitting agent

These are repo-specific and will silently corrupt a split if ignored.

1. **Do not change assertions.** This is a mechanical move. If a test only
   passed because of ordering within the old file, that is a real bug to fix
   explicitly and record — not to paper over.

2. **`--parallel` implies `--isolate`.** Each test file gets a fresh module
   registry. A test that relied on a sibling in the same file having mutated a
   global will fail once separated. Fix by making the new file set up what it
   needs; do not re-merge the files.

3. **Bun `mock.module()` is global at the module-cache level.** Read the rules
   in `AGENTS.md` before adding any mock. Shared mocks belong in
   `tests/setup.ts`; reusable mock functions in `tests/mocks/*`. Splitting one
   file into eight multiplies any top-level `mock.module()` by eight — this is
   the single largest risk in this work.

4. **Use the snapshot-and-restore pattern** when a split file must stub a
   sibling module that has its own test file. `AGENTS.md` has the worked
   example.

5. **Shared fixtures/helpers.** The big files carry large preambles (e.g.
   `commands-*.test.ts` defines its fixtures across L114-L1374, interleaved with
   the small describes: `framedContainerGitStatus` (L114), `createContext`
   (L399), `createGitWorktreeWithOrigin` (L788), `withFakeDocker` (L868),
   `withFakeGh` (L1051), `ASYNC_TEST_BUDGET_MS` (L1115), `waitForCondition`
   (L1129)).
   Extract these to a shared non-test helper module (e.g.
   `tests/unit/electron/helpers/command-fixtures.ts`) rather than copying.
   A file named `*.test.ts` is picked up by the runner — helpers must not be.

6. **Keep the intermediate layers out of it.** Do not add tests that import an
   `abstract` layer class; they cannot be instantiated. Construct the facade.

7. **Preserve timeouts.** Several tests carry `ASYNC_TEST_BUDGET_MS` as a
   third argument to `test()`. Dropping it on the move reintroduces exactly the
   flake fixed in `docs/flaky-tests.md` for the diff-stats cache tests.

8. **Run with `test:logged`.** Terminal buffers are not authoritative; the exit
   status is. See `AGENTS.md` and `docs/test-logs.md`.

9. **Record flakes.** If a test fails in the aggregate run but passes alone,
   `docs/flaky-tests.md` is the only registry — add or update its entry in the
   same change.

---

## 5. Suggested order

Lowest risk first, so the mocking rules are exercised on small files before the
hard ones:

1. `opencode-*.test.ts` and `ActionBar.test.tsx` — describe names already
   map to modules; good calibration.
2. `tmux-*.test.ts`, `app-server-runtime-*.test.ts`,
   `session-manager-*.test.ts` — clean describe structure, large payoff.
3. `build-pipeline-service-*.test.ts`, `native-agent-service-*.test.ts` — layer
   chains, split by subject.
4. `TerminalContainer*.test.tsx`, `ClaudeTmuxChatTab.test.tsx`,
   `NativeMessage.test.tsx` — renderer, highest `mock.module()` risk.
5. `gateway-*.test.ts`, `acp-bridge/src/acp-*.test.ts` — need classification.
6. `commands-*.test.ts` — largest, needs classification, do last.

Two duplicate-name pairs need a decision before starting: `NativeMessage.test.tsx`
and `storage.test.ts` each exist in both `apps/web`/`apps/backend` and `tests/`.
Confirm which is authoritative before splitting either.

## 6. Verification per file

After each split, the counts must match exactly:

```bash
bun run test:logged -- --name split-check -- bun test <old-and-new-paths> --parallel=2
```

- Total test count before == total after. A drop means tests were lost in the
  move; an increase means one was duplicated.
- Then the owning group: `bun test ./tests --parallel=4`, or
  `bun test bridges --parallel=2`, or the workspace test task.
- Then the full `bun run test` before opening a PR.
- `tests/unit/module-import-cycles.test.ts` must still report zero cycles if any
  production file was touched.

## 7. Known follow-ups unrelated to the test split

- `commands-runtime-state.ts` still loads the git-status scanners with
  `await import("./commands-files.js")`. The cycle that required it is gone, so
  it can become a static import; `commands-runtime-state-load-order.test.ts`
  would need updating in the same change.
- The import-cycle guard scopes to `apps/backend/src` and the three bridges.
  `apps/web` is not covered — the renderer component graph has a different shape
  and would need its own allow-list before it could be enforced.
