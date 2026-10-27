# Test temporary-directory leaks found by the full sweep

Checked against `main` at `93018933` plus the 0023 branch (2026-10-26).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Remove the listed leaks at source**: fix the twelve owners in Code item 1, or opt their prefixes into `tests/temp-sweep.ts`. Status: open.
2. **Preview supervisor scratch (Code 2 and Needs verification)**: decide whether `ork-artifact-preview-*` leaks in production or only in tests. Status: partly done (production path read; test source not reproduced).
3. **Hermetic process-coverage test**: `commands-process-coverage.test.ts` must not read the host's `XDG_STATE_HOME`. Status: done (by `1aabf049`); the file still lists it.
4. **Repeat the sweep**: rerun the private-`TMPDIR` sweep after the fixes. Status: open (after 1 and 2).
5. **`TMPDIR` through Turbo (open question)**: whether `mise run test` should pass `TMPDIR` so an aggregate run can be swept. Status: open.

### 1. Remove the listed leaks at source

**Problem.** One sweep found about 30 directories left in a private `TMPDIR` by passing bridge and backend suites. On a developer host they pile up under `/tmp` run after run.

**Context.** This work was found by 0023's 2026-10-26 sweep, and 0023 takes no new items. The rules come from 0023: remove a directory in the test that made it, after whatever holds it open has closed, and await the removal. `tests/temp-sweep.ts` (`createOwnedTempDir`, `sweepStaleTempDirs`, `:37-61`) is the fallback for prefixes that cannot be removed at source. Today only `apps/backend/tests/command-fixtures.ts:197`, `apps/backend/tests/standalone.test.ts:42`, `tests/isolate-git-config.ts:12` and `tests/isolate-worktree-dir.ts:7` opt prefixes in.

**Investigation.** Every owner in the table still creates its prefix at HEAD, for example `claude-mcp-sync-` (`session-manager-prompt-mcp-sync.live-probe.ts:74`), `ork-runtime-` (`bridges/codex-bridge/src/app-server-runtime-test-harness.ts:248`), `orkestrator-state-sync-` (`commands-state-sync.test.ts:68`) and `ork-env-move-` (`environment-move.test.ts:134`). `media-stream-` is at `media-stream.test.ts:47`, `mcp-mgmt-` at `mcp-management/test-support.ts:82`, and the fixed names are at `index.test.ts:44`, `:92`, `:210`, `commands-io-coverage.test.ts:99`, `:817` and `commands-registry-coverage.test.ts:30`. None of these files has changed its temp handling since the sweep.

Some files have no `afterEach` or `afterAll` at all: `commands-state-sync.test.ts`, `index.test.ts`, `mcp-management/test-support.ts` and the Claude live probe. Their removals are inline, so a failing assertion or a thrown error skips them. `index.test.ts:210` and `commands-registry-coverage.test.ts:30` use fixed names, so parallel workers can share or collide on them.

**Decisions.**

- **Fix each owner, or contain the whole run?**
  - **Fix at source per owner, using `try`/`finally` or `afterEach` with an awaited `rm` (recommended).** Use `createOwnedTempDir` for fixed or `<uuid>` names that cannot be awaited.
    - Pros: follows the 0023 rules; each fix is small and local; fixed names stop colliding between parallel workers.
    - Cons: twelve separate edits; a new leaking test is caught only by the next sweep.
  - **Give each `scripts/test-all.ts` group a private `TMPDIR` and remove it after the group.**
    - Pros: catches every leak, present and future, at once.
    - Cons: hides the leaks instead of fixing them; needs `TMPDIR` passed through Turbo (task 5); a test that intentionally keeps state across groups would break; it does nothing for focused `bun test` runs.

### 2. Preview supervisor scratch

**Problem.** Five `ork-artifact-preview-*` directories, each holding `.cache` and `.config` (so Chromium ran in them), were left behind. If production leaks them too, every preview a user runs can leave a directory behind.

**Context.** Code item 2 and the Needs-verification item ask the same question. [0248](0248-playwright-profile-dir-leaks.md) tracks the Playwright profiles that end up inside these directories.

**Investigation.** In production, `superviseWorker` creates the scratch directory only for process isolation (`preview-supervisor.ts:362`). It removes it only after a verified termination (`:338`) or a verified `reap` (`:345-350`), or when the spawn throws (`:379`). The comment at `:262` says a failed removal is "retried by the next verified reap". But nothing sweeps `ork-artifact-preview-*` at startup, so a job whose kill is never verified, or whose backend exits first, leaks its directory in production. The leak is bounded by the number of jobs.

I ran each preview-reaching test file alone under a private `TMPDIR`: `preview-supervisor`, `preview-isolation`, `preview-runaway`, `mermaid-render`, `preview-escape`, `preview-interactive`, `preview-modules`, `preview-print` and `preview-admission`. None left a scratch directory. So the five from the sweep most likely come from kills that were not verified under the aggregate's parallel load, not from a test that never stops its job. Separately, `preview-modules.test.ts` failed one test alone ("Chart.js named and chart.js/auto imports passes its probes offline": probe 2 observed "different"), which is outside this file.

**Decisions.**

- **How to stop scratch outliving its job?**
  - **Sweep stale `ork-artifact-preview-*` directories under the scratch root at backend start, and when admitting a preview, only when no live job owns them (recommended).** Embed the owning PID in the name, as `ownedTempDirPrefix` does.
    - Pros: covers unverified kills and backend crashes in production and tests alike; the sweep is bounded and owner-checked.
    - Cons: a new startup cost; the name format changes.
  - **Treat it as test-only and remove the directories in test teardown.**
    - Pros: no production change.
    - Cons: the code shows production can leak on an unverified kill, so this hides a real, if rare, leak.

### 3. Hermetic process-coverage test

**Problem.** The test read the host's real `~/.local/state/opencode/model.json` when `XDG_STATE_HOME` was set.

**Context.** It passed under `mise run test` only because Turbo drops the variable.

**Investigation.** This is fixed. `apps/backend/tests/commands-process-coverage.test.ts:449` now sets `XDG_STATE_HOME` inside the fake home, and `:23` and `:498-499` restore it. The change came with `1aabf049` (#1307), but this file was not updated. `XDG_CONFIG_HOME` and `XDG_DATA_HOME` are still inherited, but `commands-containers.ts:517-524` reads them only for the `agent-test` runtime flavour, so they do not affect this test today.

**Decisions.**

- **Close the item, or also pin the other XDG variables?**
  - **Tick the item as done, citing `1aabf049` (recommended).**
    - Pros: matches the code; keeps the change minimal.
    - Cons: a future agent-test-flavour case in this file could read the host's config or data home.
  - **Also set `XDG_CONFIG_HOME` and `XDG_DATA_HOME` in the fixture.**
    - Pros: fully hermetic.
    - Cons: guards against a case no test exercises today.

### 4. Repeat the sweep

**Problem.** Nothing yet proves the fixes worked.

**Context.** The sweep has to run outside Turbo, because Turbo drops `TMPDIR`. The 2026-10-26 run used `test:bridge` in each of the five bridges and `bun run --cwd apps/backend test:workspace`.

**Investigation.** Nothing has changed since the first sweep, so a repeat now would only reproduce the table.

**Decisions.**

- **When and how to repeat it?**
  - **After tasks 1 and 2, with the same commands and a private `TMPDIR`, recording the remaining entries against the "Not leaks" list (recommended).**
    - Pros: like-for-like with the recorded baseline.
    - Cons: does not cover the root `./tests` group or other workspaces.
  - **Also sweep the root `./tests` and the web workspace.**
    - Pros: finds the remaining unlisted leaks.
    - Cons: new findings must go into a new todo file, and it takes longer.

### 5. `TMPDIR` through Turbo

**Problem.** An aggregate `mise run test` cannot be swept, and it ignores an operator's chosen temporary directory.

**Context.** `turbo.json` declares per-task `passThroughEnv` lists (for example `test:workspace` and `test:bridge`), and none of them names `TMPDIR`. There is no `globalPassThroughEnv`.

**Investigation.** Passing `TMPDIR` would not change cache keys, because the test tasks are `cache: false`.

**Decisions.**

- **Pass `TMPDIR` through?**
  - **Yes, add `TMPDIR` to `globalPassThroughEnv` (recommended).**
    - Pros: one aggregate run can be swept; honours operator configuration; no cache effect.
    - Cons: a host with an unusual `TMPDIR` (for example a small tmpfs) now affects tests that used to fall back to `/tmp`.
  - **No, keep sweeping outside Turbo.**
    - Pros: no behaviour change.
    - Cons: every sweep needs a hand-built list of group commands.

[0023](0023-environment-and-disk-cleanup.md) fixed the test temp-directory
leaks it listed. Its 2026-10-26 sweep then ran the bridge and backend suites
with a private `TMPDIR` and found many more directories left behind, plus one
test that reads the host's real state. This file holds that newly found work;
0023 does not take new items.

## Current state

- How the inventory below was taken (omarchy-hp, Arch Linux x86_64): an empty
  `TMPDIR=/tmp/ork0023-sweep/tmp`, then `test:bridge` in each of the five
  bridges, for example `mise exec -- bun run --cwd bridges/codex-bridge test:bridge`
  (all five passed),
  and `mise exec -- bun run --cwd apps/backend test:workspace` (11,721 passed,
  142 skipped, 2 failed: flake 0785, and the test in Code item 3). They were
  run outside Turbo because `mise run test` runs these groups through Turbo's
  strict environment mode, which does not pass `TMPDIR` through, so an
  aggregate run cannot be swept this way.
- `tests/temp-sweep.ts` (`createOwnedTempDir`, `sweepStaleTempDirs`) is the
  existing fallback for prefixes that cannot be removed at source.
- 0023 believed `ork-runtime-` and `orkestrator-state-sync-` were removed on
  the normal path. This sweep left four and three of them, in runs where
  their owning files passed.

## Outstanding work

### Code

1. Remove these at source (or, where that is impossible, opt the prefix into
   `tests/temp-sweep.ts`). Counts are from one sweep; "owner" is where the
   prefix is created.

   | Left behind | Count | Owner |
   | --- | --- | --- |
   | `claude-mcp-sync-*` | 5 | `bridges/claude-bridge/src/services/session-manager-prompt-mcp-sync.live-probe.ts`, via `session-manager-prompt-mcp-sync.live.test.ts` |
   | `ork-runtime-*` | 4 | `bridges/codex-bridge/src/app-server-runtime-test-harness.ts` (created during the bridge phase; `backend-runtime.test.ts` and `runtime-prepare.test.ts` use the same prefix) |
   | `orkestrator-state-sync-*` | 3 | `apps/backend/src/core/commands-state-sync.test.ts` |
   | `ork-env-move-*` | 3 | `apps/backend/src/core/environment-move.test.ts` |
   | `ork-artifact-preview-*` | 5 | the scratch directory of `transcript-artifacts/preview-supervisor.ts`, reached from the preview tests; holds `.cache` and `.config` |
   | `mcp-mgmt-*` | 2 | `apps/backend/src/core/mcp-management/test-support.ts` |
   | `ork-terminal-history-*` | 1 | `apps/backend/src/core/terminal-history.test.ts` |
   | `ork-clone-capacity-*` | 1 | `apps/backend/src/core/commands-registry-project-copy.test.ts` |
   | `media-stream-*` | 1 | `apps/backend/src/core/transcript-artifacts/media-stream.test.ts` (left a `staging/` directory) |
   | `ork-backend-activity-event-<uuid>`, `ork-backend-activity-stamp-<uuid>`, `ork-backend-interaction-env` | 1 each | `apps/backend/src/core/index.test.ts` |
   | `ork-commands-io-history-<pid>`, `outside-profile.bin` | 1 each | `apps/backend/tests/commands-io-coverage.test.ts` |
   | `ork-command-registry-data` | 1 | `apps/backend/tests/commands-registry-coverage.test.ts` |

2. Decide whether the preview supervisor itself leaks its scratch directory in
   production, or only the tests skip stopping it (see Needs verification).
3. Make `process and platform command behavior > controls bridge processes,
   reads logs and preferences, and reports port health`
   (`apps/backend/tests/commands-process-coverage.test.ts`) hermetic. It sets
   a fake `HOME`, but `commands-containers.ts` prefers `XDG_STATE_HOME`, so
   with the host's `XDG_STATE_HOME` set it reads the real
   `~/.local/state/opencode/model.json` and fails on its recent models. It
   passes under `mise run test` only because Turbo drops the variable; with
   `env -u XDG_STATE_HOME` the file passed 67 of 67. The test should set or
   clear the XDG variables it depends on.

### Qualification

1. Repeat the sweep above after the fixes and record that the private
   `TMPDIR` holds only intended entries.

## Constraints and rationale

- The same rules as 0023: remove a directory in the test that made it, after
  whatever holds it open has closed; await the removal so the process cannot
  exit first; `tests/temp-sweep.ts` removes a directory only when its PID is
  dead and it is past the age limit.
- Not leaks (do not "fix"): `orkestrator-test-run.*` (failure logs, kept 7
  days by `scripts/test-all.ts`), `orkestrator-test-scheduler-v1-<uid>` and
  `orkestrator-test-timings.*` (scheduler state), `orkestrator-mcp-locks-<uid>`
  (the per-user lock directory of `mcp-management/source-store.ts`, by
  design), and other tools' own caches and scratch (`jiti`,
  `node-compile-cache`, `playwright-transform-cache-<uid>`,
  `org.chromium.Chromium.*`, `claude-<uid>`).
- `policy-cli-*` is left only when the live OpenCode research test times out;
  it belongs to flake
  [0785](../../tests/flaky-tests/coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md).

## Open questions

- Should `mise run test` pass `TMPDIR` through Turbo (`globalPassThroughEnv`)
  so a single aggregate run can be swept? It would also make the suite honour
  an operator's chosen temporary directory.

## Needs verification

- Whether `preview-supervisor.ts` removes its `ork-artifact-preview-*` scratch
  directory when a preview stops, or whether the five left here come only from
  tests that never stop it.

## Related

- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
  (the first leak list and the sweep that found these).
- [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md).
- [Disk usage](../../development/disk-usage.md).
- [0248-playwright-profile-dir-leaks.md](0248-playwright-profile-dir-leaks.md)
  (leftover Playwright profiles, including those inside `ork-artifact-preview-*`).

## Replaces

Nothing; new work found on 2026-10-26.
