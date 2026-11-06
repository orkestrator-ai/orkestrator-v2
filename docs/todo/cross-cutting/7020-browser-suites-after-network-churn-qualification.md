# Browser-suite follow-ups from the Docker network churn qualification

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`, on beelink (Linux 7.1.8,
Docker Engine 29.9.2, Playwright 1.64.0 with Chromium 156), while closing task 3
of to-do 4222 (done; deleted 2026-11-06). The runs and their attribution are in
flake [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md),
section "The whole browser suite under churn, 2026-11-06".

### Tasks

1. **An environment move failed with `claude-tmux cleanup incomplete`**: `local environment move survives inactive navigation and reload` failed once because the move command answered 500. Status: open.
2. **Qualify the loopback-only namespace for `test:browser` beyond beelink**: review validation and other Linux hosts have not run the suites through `scripts/loopback-network.ts`. Status: open.
3. **`agent-accounts.spec.ts:229` (390px) with credentials**: the one failure recorded on 2026-11-05 has not been rerun on a profile with Claude credentials. Status: open.

### 1. An environment move failed with `claude-tmux cleanup incomplete`

**Problem.** In run 1 (isolated browser suite at `e6c3da899`, natural churn,
2026-11-05 23:52 UTC), `local environment move survives inactive navigation and
reload` (`e2e/agent-testing/browser-gateway.spec.ts`) failed at its first
`expect.poll` on the environment's `worktreePath`: after 5 s it was still the
original path. The trace holds one `POST /__orkestrator/invoke` answered 500 with
`{"error":"claude-tmux cleanup incomplete for environment <id>"}` when the move
was confirmed, and no `net::ERR_NETWORK_CHANGED` at all. The sidebar showed only
the other fixture environment, with a spinner.

**Context.** The message comes from the tmux teardown in
`apps/backend/src/core/tmux-commands.ts` (the `throw` after `restoreWorkspaceHooks`),
which a move runs before it relocates the worktree. `cleanupComplete` turns
false when the environment list cannot be loaded, when
`killEnvironmentTmuxSessions` (`tmux-session-manager.ts`) reports an incomplete
kill, or when restoring the workspace hooks fails. Flake
[0786](../../tests/flaky-tests/backend-services-and-tooling/0786-tmux-interactive-polling-teardown-rejection.md)
was the same message in a unit test, caused by the host's own tmux server in
the process census.

**Investigation.** The profile was a credential-free Codex profile with no
Claude tmux session open. The case passed in runs 3 to 7 (five more runs), and
failed in run 2 only because its page lost its modules to churn. The profile's
backend log was removed with the profile, so which of the three conditions
fired is not known. Beelink runs many tmux servers for other worktrees.

**Decisions.**

- **How to find which condition fired?**
  - **Log the failing branch and rerun the case until it recurs (recommended).** The three `cleanupComplete = false` sites already log at `warn`; keep a copy of the profile's backend log before `dev:reset` (copy `logs/` while the run is live) and run the case with `--repeat-each` on a `--headless --fixture` profile.
    - Pros: names the cause from evidence; no product change before it is understood.
    - Cons: a one-in-seven failure needs many repeats; it may need the host's other tmux servers to reproduce.
  - **Treat a move's tmux cleanup as best-effort.**
    - Pros: the move would proceed.
    - Cons: a surviving tmux session would keep the old worktree path open, which is what the check protects against.

### 2. Qualify the loopback-only namespace for `test:browser` beyond beelink

**Problem.** `mise run test:browser` now runs both Playwright suites through
`scripts/loopback-network.ts`, which on Linux uses `unshare --user
--map-root-user --net` and raises `lo` with `ip`. It has run on beelink only.

**Context.** Hosts that refuse unprivileged user namespaces (for example Ubuntu
24.04 with `kernel.apparmor_restrict_unprivileged_userns=1`, the GitHub runner
image) or lack `ip` fall back to the host network and print one line saying so.
CI does not call `test:browser`; review validation does
(`.orkestrator-test-scheduler.json`). macOS keeps the host network.

**Investigation.** On beelink, under this work's churn, the component suite
inside the namespace passed 1,475 of 1,618 cases with 15 failures and no
network-change aborts (component run B); the same suite on the host network
lost 850 of its first 1,024 cases to them (component run A); the public-site
suite passed inside the namespace (16.6 s). The committed task under the same
churn (component run C) printed that it ran in the namespace and passed 1,479
cases with 11 load-sensitive failures and no network-change aborts.

**Decisions.**

- **How to qualify it?**
  - **Watch the first review-validation runs on another Linux host and on macOS (recommended).** Confirm the notice line (isolated or why not) and that the suite result matches a `ORKESTRATOR_E2E_HOST_NETWORK=1` run.
    - Pros: no extra machinery; review validation already runs the task.
    - Cons: depends on those runs happening and someone reading the line.
  - **Add a CI job that runs one component spec through the wrapper.**
    - Pros: continuous evidence on a hardened kernel.
    - Cons: GitHub's runner refuses unprivileged user namespaces by default, so it would only prove the fallback.

### 3. `agent-accounts.spec.ts:229` (390px) with credentials

**Problem.** The review preparation for the 2026-11-05 change recorded this case
failing once on a credentialed profile with the Settings dialog still over the
drawer toggle and its modules loaded.

**Context.** This build was not allowed to use real logins, so every run here
was credential-free.

**Investigation.** All four `agent-accounts.spec.ts` cases, the 390px one
included, passed in each of the seven isolated runs here (credential-free). The
companion failure that 4222 recorded, `cli-ui.spec.ts` "a CLI-initialized
project…", recurred in runs 1 and 2 as a race with the sidebar's automatic
collapse of empty projects and was fixed (flake
[0901](../../tests/flaky-tests/web-ui/0901-cli-ui-fixture-project-hydration.md)).

**Decisions.**

- **Rerun with credentials, or close on these runs?**
  - **Rerun the case alone with `--repeat-each=3` on a profile with Claude credentials (recommended).**
    - Pros: tests the condition the failure was seen in.
    - Cons: needs a host where using the Claude login is allowed.
  - **Close it on seven credential-free passes.**
    - Pros: no further run.
    - Cons: the credentialed startup path (no sign-in modal) was the one that failed.

## Related

- Flake [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md), the cause and the run record.
- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), whose qualification found the original failures.
- [2921](2921-component-browser-failures-on-main.md), other `test:browser` failures.
