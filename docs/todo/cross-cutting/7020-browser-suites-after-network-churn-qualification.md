# Browser-suite follow-ups from the Docker network churn qualification

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`, on beelink (Linux 7.1.8,
Docker Engine 29.9.2, Playwright 1.64.0 with Chromium 156), while closing task 3
of to-do 4222 (done; deleted 2026-11-06). The runs and their attribution are in
flake [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md),
section "The whole browser suite under churn, 2026-11-06".

Analysed 2026-11-09 against `main` at `c6de4733c`, on beelink, for tasks 1
and 2 (see [Assumptions and decisions](#assumptions-and-decisions)).

Analysed 2026-11-10 against `main` at `c6de4733c` (branch head `10d5c9b31`),
on beelink, for the failed whole-suite `test:browser` run of task 2.

### Tasks

1. **An environment move failed with `claude-tmux cleanup incomplete`**: `local environment move survives inactive navigation and reload` failed once because the move command answered 500. Status: done (2026-11-09): cause reproduced on the real stack and fixed.
2. **Qualify the loopback-only namespace for `test:browser` beyond beelink**: review validation and other Linux hosts have not run the suites through `scripts/loopback-network.ts`. Status: open: Ubuntu 24.04 and Debian 13 userlands qualified on beelink's kernel (2026-11-09); macOS remains (a Linux host with another kernel or hardening moved to [7568](../manual-test/7568-manual-test-checklist.md) on 2026-11-10); and a whole-suite `test:browser` pass on beelink has not been observed since: the 2026-11-10 run failed 131 cases at a load average above 100 and was stopped with 1,542 unrun.

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

2026-11-10, the whole suite on beelink at `10d5c9b31`: one `mise run
test:browser` run (default 8 workers, no review-validation retry) printed that
it ran in the namespace, then had 131 failures, 67 passes, 58 skips and 6
interrupted when it was stopped after 856 s with 1,542 of 1,804 component cases
not run; the public-site suite did not start. The host's load average was 106
to 125 on 16 cores at the time. Of the failures, 62 were `page.goto` or
`page.reload` hitting the test timeout (30 s, or 60 s in two), most of the rest other 30 s action
timeouts and `toBeVisible` misses; none was `net::ERR_NETWORK_CHANGED` and one
was `ERR_ABORTED`. To attribute them, five of the failing spec files
(`AgentUsage`, `BackgroundTaskOutcome`, `ChatColumnShift`,
`EnvironmentStatusMarker`, `FocusVisibility`; 76 cases) were run alone:

| Network | Workers | Load average at start | Failed | Passed |
| --- | --- | --- | --- | --- |
| namespace | 8 | 102 | 28 | 42 |
| host (`ORKESTRATOR_E2E_HOST_NETWORK=1`, own port) | 8 | 95 | 12 | 58 |
| namespace | 8 | 98 | 31 | 39 |
| namespace | 2 | 36 | 0 | 70 |
| namespace | 2 | 36 | 0 | 70 |
| namespace | 8 | 29 | 0 | 70 |
| host (`ORKESTRATOR_E2E_HOST_NETWORK=1`, own port) | 8 | 42 | 24 | 46 |

Six cases skip in every run. On both networks the failures came and went with
the host's load: the same tests, the same timeouts, and no network-change abort
in any run; the 8-worker namespace run at the lowest load was clean, and the
host-network run at load 42 failed 24. That points to load-sensitive cases on
an oversubscribed host rather than to the namespace. It does not settle it: at
a load near 100 the two namespace runs failed more than the one host-network
run (28 and 31 against 12), and one run per point cannot say whether that is
load drift between runs or a cost the namespace adds under heavy load. It is
also a sample of five files, not the whole suite. A whole-suite pass inside
the namespace on beelink, which component runs B and C nearly were
(2026-11-06), has not been repeated on this branch.

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
- **How to close the whole-suite gap on beelink?**
  - **Run `mise run test:browser` once when the host's load average is below about half its cores, and compare a failing set, if any, with the same files under `ORKESTRATOR_E2E_HOST_NETWORK=1` run straight after (recommended).**
    - Pros: tests the whole suite under the condition the sample passed in; an immediate host-network rerun of the same files separates the namespace from load.
    - Cons: needs a quiet window on a shared build host, which this build could not wait for.
  - **Rely on review validation's run, which grants workers and retries a failed case once.**
    - Pros: no extra run; it is the run that gates the change.
    - Cons: under the same load, retries hide rather than explain a namespace effect, and the last captured review package did not run `test:browser` at all.
  - **Lower the component suite's worker count or raise its 30 s test timeout.**
    - Pros: fewer load misses.
    - Cons: changes every run, idle hosts included, to cover a busy one; the scheduler already passes `ORKESTRATOR_VALIDATION_GRANTED_WORKERS` for this.

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

### Task 2: attribute the failed whole-suite run with a sample, not a second whole run

The 2026-11-10 `test:browser` run failed 131 cases while beelink's load average
was above 100, with no network-change abort. Rather than rerun all 1,804 cases
on the same busy host, five of the failing files were run alone in the
namespace and on the host network at different loads (table under task 2's
Investigation). That separates load from the namespace for those files; it does
not stand in for a whole-suite pass, so the task stays open for one.

## Outstanding work

- Task 2: run `test:browser` on a macOS node, where no `[loopback-network]`
  line is printed, and confirm the result matches an
  `ORKESTRATOR_E2E_HOST_NETWORK=1` run. The same check on a Linux host other
  than beelink (ideally Ubuntu 24.04 with its default AppArmor restriction)
  moved to [7568](../manual-test/7568-manual-test-checklist.md).
- Task 2: a whole-suite `mise run test:browser` pass inside the namespace on
  beelink is not established on this branch. The only whole run (2026-11-10,
  `10d5c9b31`) failed 131 cases (62 navigation timeouts, none a network-change
  abort), interrupted 6 and left 1,542 component cases and the whole
  public-site suite unrun when it was stopped at a load average above 100.
  A five-file sample points to host load on both networks rather than the
  namespace (table under task 2), though near load 100 the namespace runs
  failed more than the one host-network run; the other files and the
  public-site suite have not run. Remaining: run `test:browser` once when the load average is below about
  8 on beelink, and if anything fails, rerun those files straight after with
  `ORKESTRATOR_E2E_HOST_NETWORK=1` and a free `ORKESTRATOR_E2E_PORT`; a failure
  only inside the namespace is a defect of the wrapper. Not done here because
  the host stayed oversubscribed by other builds for the whole of this work,
  and the build may not stop them.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 3, the other-kernel Linux host of task 2) moved there on 2026-11-10.
- Flake [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md), the cause and the run record.
- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), whose qualification found the original failures.
- [2921](2921-component-browser-failures-on-main.md), other `test:browser` failures.
