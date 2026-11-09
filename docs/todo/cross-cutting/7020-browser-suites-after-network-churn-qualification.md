# Browser-suite follow-ups from the Docker network churn qualification

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`, on beelink (Linux 7.1.8,
Docker Engine 29.9.2, Playwright 1.64.0 with Chromium 156), while closing task 3
of to-do 4222 (done; deleted 2026-11-06). The runs and their attribution are in
flake [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md),
section "The whole browser suite under churn, 2026-11-06".

Analysed 2026-11-09 against `main` at `c6de4733c`, on beelink, for tasks 1
and 2 (see [Assumptions and decisions](#assumptions-and-decisions)).

### Tasks

1. **An environment move failed with `claude-tmux cleanup incomplete`**: `local environment move survives inactive navigation and reload` failed once because the move command answered 500. Status: done (2026-11-09): cause reproduced on the real stack and fixed.
2. **Qualify the loopback-only namespace for `test:browser` beyond beelink**: review validation and other Linux hosts have not run the suites through `scripts/loopback-network.ts`. Status: open: Ubuntu 24.04 and Debian 13 userlands qualified on beelink's kernel (2026-11-09); a host with another kernel or hardening, and macOS, remain.
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

2026-11-09: the condition is `killEnvironmentTmuxSessions` reporting an
incomplete kill, and it is a product defect, not a test race. The backend's
own socket (`/tmp/tmux-1000/default` on beelink) had no server, so
`tmux list-sessions` answered `error connecting to … (No such file or
directory)`. `confirmTmuxSessionGone` (`tmux-shared.ts`) then took a `ps`
census and treated **any** tmux process on the host as a possible owner of
that socket: another worktree's tests on a private socket, a container's tmux.
The move failed whenever one happened to be running, which is why it was
intermittent; deletes hit the same rejection but swallow it (`delete.step-failed
step=claude-tmux`), leaving the runtime root behind. This branch was the one
`cleanupComplete = false` site that logged nothing.

- Function level: with a private `TMUX_TMPDIR` and no server, the result was
  `complete: true`; with one decoy server on an unrelated socket,
  `complete: false`; after the decoy stopped, `true` again.
- Real stack (profile `c25a-7020-move`, `--fixture --headless
  --no-agent-credentials --agent-platforms codex`, one decoy tmux server on a
  private socket): on the old census the case failed 2 of 2
  (`--repeat-each=2`) at the same first `worktreePath` poll as run 1, and the
  backend log held `[tmux] cleanup.kill-incomplete killed=0` before each move
  and `claude-tmux cleanup incomplete` from each fixture delete. With the fix,
  the same decoy running, it passed 3 of 3 (`--repeat-each=3`) with no
  cleanup warning.
- Separate observation from the failing run: the global teardown reported
  `ArtifactBoundError` because a failed case's trace exceeded the 64 MiB
  sanitization limit. It did not affect the result.

**Decisions.**

- **How to find which condition fired?**
  - **Log the failing branch and rerun the case until it recurs (recommended).** The three `cleanupComplete = false` sites already log at `warn`; keep a copy of the profile's backend log before `dev:reset` (copy `logs/` while the run is live) and run the case with `--repeat-each` on a `--headless --fixture` profile.
    - Pros: names the cause from evidence; no product change before it is understood.
    - Cons: a one-in-seven failure needs many repeats; it may need the host's other tmux servers to reproduce.
  - **Treat a move's tmux cleanup as best-effort.**
    - Pros: the move would proceed.
    - Cons: a surviving tmux session would keep the old worktree path open, which is what the check protects against.
- **How to fix the census once the cause was known?**
  - **On Linux, rule out only tmux processes that provably serve another socket (recommended, implemented).** A listening Unix socket keeps its bound path in `/proc/net/unix` after its file is deleted, and that table covers every process in the reader's network namespace. A process is ruled out when it shares the namespace and the path is not listed, or when it sees a different directory where the socket lives (a container's own `/tmp`), or when it has exited. Everything else, and every host without `/proc`, stays conservative.
    - Pros: a live server whose socket file was deleted still blocks the move, which is what the census exists for; runs through the same `exec` as the census, so a container backend probes inside its container.
    - Cons: Linux only (macOS keeps the old behaviour); a tmux in another network namespace that shares the socket directory still blocks, as does one whose `/proc` entries this user cannot read.
  - **Give the backend's tmux a private socket of its own.**
    - Pros: no census needed for a socket only this backend uses.
    - Cons: changes where every existing claude-tmux session lives, so it needs a migration for running sessions; much larger than the defect.

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

2026-11-09, on beelink in containers (`--network none`, so no Docker network
was created), with the wrapper's notice now naming the missing prerequisite
(`unshare`, `ip`, or the host's refusal with the kernel's message):

| Userland | Seccomp | Notice | Result |
| --- | --- | --- | --- |
| Ubuntu 24.04 (`mcr.microsoft.com/playwright:v1.64.0-noble`), uid 1000 | Docker default | host network: refused (`unshare: unshare failed: Operation not permitted`) | Chromium loaded a loopback page on `127.0.0.1` and `localhost` |
| Ubuntu 24.04, uid 1000 | unconfined | host network: `ip` (iproute2) is not installed | same |
| Debian 13 (`orkestrator-v2:dev-d6659766d696`), `node` | Docker default | host network: refused, as above | same; exit status 7 passed through |
| Debian 13, `node` | unconfined | private loopback-only namespace | same; only `lo` visible; exit status 7 passed through |
| Debian 13, `node` | unconfined | namespace, then `ORKESTRATOR_E2E_HOST_NETWORK=1` | the 13 smallest component specs: 49 passed, 3 skipped in both (2.5 min and 2.1 min) |

Every container shares beelink's kernel (7.1.8-arch1-3), so none of this
reproduces Ubuntu's `kernel.apparmor_restrict_unprivileged_userns=1`, which is
a host setting. The Docker seccomp refusal exercises the same fallback path.
The evidence files are under `output/agent-testing/c25a-7020-loopback/` in the
worktree that ran them (not committed).

**Decisions.**

- **How to qualify it?**
  - **Watch the first review-validation runs on another Linux host and on macOS (recommended).** Confirm the notice line (isolated or why not) and that the suite result matches a `ORKESTRATOR_E2E_HOST_NETWORK=1` run.
    - Pros: no extra machinery; review validation already runs the task.
    - Cons: depends on those runs happening and someone reading the line.
  - **Add a CI job that runs one component spec through the wrapper.**
    - Pros: continuous evidence on a hardened kernel.
    - Cons: GitHub's runner refuses unprivileged user namespaces by default, so it would only prove the fallback.
- **What can be qualified without another host?**
  - **Run the wrapper in containers of other userlands, and make its notice name the cause (recommended, done).**
    - Pros: proves the fallback on two distributions and isolation with Chromium on Debian 13; a review-validation log on another host now says which prerequisite is missing.
    - Cons: same kernel as beelink, so a different kernel's or AppArmor's behaviour stays unobserved.
  - **Leave it to the first review-validation runs elsewhere.**
    - Pros: no work now.
    - Cons: the fallback line did not say why, so a failure there would need a rerun to diagnose.

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

## Assumptions and decisions

### Task 1: fix the census rather than only log it

The recommended step was to log the failing branch and rerun until it recurred.
The decoy reproduction made it recur every time, so the cause was established
first and then fixed (`tmux-socket-owner.ts`, called from
`confirmTmuxSessionGone`). The silent branch now logs
`tmux cleanup.kill-incomplete` with the count of sessions killed, so a future
occurrence names its step. Tests: `apps/backend/tests/unreachable-socket-owner.test.ts`
(default tier: parsing, verdicts, and the real probe against a deleted
listening socket) and `apps/backend/tests/tmux-socket-owner-live.test.ts`
(slow tier, real tmux: a decoy is ruled out, a server whose socket file was
deleted still blocks, a container-like namespace with its own `/tmp` is ruled
out, and a namespace sharing the directory still blocks).

### Task 1: same commit removes a duplicate fixture key

`apps/backend/tests/command-fixtures.ts` listed
`deleteAutoPipelineDraftsByEnvironment` twice on `main` (from #2020), which
failed `bun run --cwd apps/backend typecheck`. The duplicate line was removed so
this change's validation could typecheck; it changes no behaviour.

### Task 2: containers instead of another host

No other Linux host or macOS was available to this build. Containers of other
userlands were run with `--network none` so the qualification created no
Docker network on a host that has exhausted its pool before. What remains is
recorded under Outstanding work.

## Outstanding work

- Task 2: read the `[loopback-network]` line in the first `test:browser` review
  validation on a Linux host other than beelink (ideally Ubuntu 24.04 with its
  default AppArmor restriction) and on macOS, where no line is printed, and
  confirm the result matches an `ORKESTRATOR_E2E_HOST_NETWORK=1` run. This
  needs those hosts; beelink's kernel cannot show another kernel's behaviour.
- Task 3: unchanged; needs a host where using the Claude login is allowed.

## Related

- Flake [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md), the cause and the run record.
- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), whose qualification found the original failures.
- [2921](2921-component-browser-failures-on-main.md), other `test:browser` failures.
