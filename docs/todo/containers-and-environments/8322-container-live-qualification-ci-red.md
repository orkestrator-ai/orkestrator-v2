# Container live qualification CI is red on every run (C15 and unseeded C23)

## Task analysis

Analysed 2026-11-23 against `main` at `307d19317`. Found while validating
pull request #2541 (Antigravity), which changes neither case's code path.
Tasks 1 and 2 built on 2026-11-23 against `main` at `d14e326bd`.

### Tasks

1. **Make the unseeded C23 case independent of the runner's shared GitHub quota**. Status: done.
2. **Make C15 classify a graceful daemon restart during the copy as `daemon-unavailable` on GitHub's runners**. Status: done.
3. **Get one green Container live qualification run on both architectures**. Status: open (waits on a green scheduled run on `main`).

### 1. Make the unseeded C23 case independent of the runner's shared GitHub quota

**Problem.** The step "Live firewall without workflow seed" runs
`container-live-firewall.test.ts` "C23 allowlist edits, refresh and
revocation > restricted boot fetches GitHub ranges without a workflow seed".
It fails at line 202, where `readGithubRangesSeed(seed)` is still `null`
after the container is created (`Expected and actual values must be numbers
or bigints`), so the backend's own fetch of `api.github.com/meta` produced
no seed.

**Context.** The workflow's own comment above "Seed GitHub's address ranges"
says a hosted runner's shared address has often spent the unauthenticated
quota (60 an hour), which is why every other suite is seeded with the job
token. This one case deliberately makes the unauthenticated request.
`refreshGithubRangesSeed` (`apps/backend/src/core/git/github-ranges-cache.ts`)
swallowed the failure without a log line, so the CI log could not say
whether it was a 403, a timeout or a malformed answer.

**Investigation.** The same case failed on linux-x64 in PR runs
45091972830 (#2541), 45092486300 and 45023521761, from unrelated branches.
The scheduled run on `main` failed on 2026-10-26, 11-02, 11-09 and 11-16.
The reason for the empty seed was not observed (no log line).

**Decisions.**

- **How should the case stop depending on the shared quota?**
  - **Inject the token into the backend's fetch for this run only, and log the fetch outcome (recommended).**
    - Pros: still proves the backend fetches and writes the seed itself, which is what the case is for; the log line (status class, no body) makes the next failure diagnosable.
    - Cons: needs an opt-in authenticated path in `refreshGithubRangesSeed` that production does not use.
  - **Keep the unauthenticated request and retry or skip on 403.**
    - Pros: no product change.
    - Cons: a skip hides a real regression; retries within the hour do not help when the quota is spent.
  - **Remove the step.**
    - Pros: the run turns green.
    - Cons: nothing qualifies the unseeded path any more.

### 2. Make C15 classify a graceful daemon restart during the copy as `daemon-unavailable` on GitHub's runners

**Problem.** "C15 Docker daemon restart during the rebuild copy > a daemon
restart while the volume copy helper writes keeps the original set, and a
retry succeeds" fails on both architectures with
`ContainerLifecycleError:needs-attention: Copying the environment's files
failed verification (helper-failed)` instead of `daemon-unavailable`.

**Context.** [container-qualification.md](../../development/container-qualification.md)
("Signal-only copy failures on GitHub's runners (2026-11-22)") describes
this: Engine 28.0.4 shuts down gracefully under `systemctl restart docker`,
and the `die`-event lookup added then still lets "a graceful restart that
completes before the lookup and leaves no connection error" surface as
`helper-failed`. The original set is kept, so the outcome is safe; only the
classification is wrong.

**Investigation.** It failed in every run listed under task 1, including
45042080462. The step logs were not examined for the helper's `die` event.
Docker publishes no daemon start time (`docker info` and `docker version`
carry none), but moby's `configureNetworking` deletes and recreates the
default `bridge` network at every daemon start when no container survives
it ("Clear stale bridge network"), so that network's ID and creation time
change exactly on a restart.

**Decisions.**

- **Where should the fix go?**
  - **Record the helper's exit status and the daemon's start time before and after the copy, and treat a changed daemon start time as an outage (recommended).**
    - Pros: independent of event history eviction and of connection wording.
    - Cons: one more Docker call around each copy.
  - **Relax the test to accept `helper-failed` on a graceful restart.**
    - Pros: green at once.
    - Cons: the user would be told to inspect a failed copy that was really a daemon restart.

### 3. Get one green Container live qualification run on both architectures

**Problem.** Several to-dos in this folder (6101, 6820, 7420, 7770, 0729,
0870) wait on a green or complete run of this workflow.

**Context.** The workflow is not a required check, so pull requests merge
with it red; AGENTS.md asks for a green rerun or a recorded reason. The
pull request that built tasks 1 and 2 changes files on the workflow's path
filter, so it runs the workflow itself.

**Investigation.** None beyond tasks 1 and 2. Neither fix has run on
GitHub's runners yet.

**Decisions.**

- **When to close this file?**
  - **After a scheduled run on `main` passes on both architectures (recommended).**
    - Pros: proves the fix, not one lucky rerun.
    - Cons: waits up to a week.
  - **After one green pull-request run.**
    - Pros: sooner.
    - Cons: a pull request runs only when its paths match.

## Current state

- **Task 1.** The backend's `/meta` fetch sends `Authorization: Bearer` only
  when `ORKESTRATOR_QUALIFICATION_GITHUB_META_TOKEN` is set
  (`GITHUB_RANGES_FETCH_TOKEN_ENV`). The workflow sets it to
  `${{ github.token }}` on the "Live firewall without workflow seed" step and
  nowhere else (`tests/unit/ci-workflows.test.ts` checks both). Every fetch
  that writes no seed logs `github-ranges.fetch-failed` with `outcome`
  (`http-4xx`, `http-5xx`, `http-other`, `rate-limited`, `timeout`,
  `network-error`, `malformed`, `write-failed`), `status`, `authenticated`
  and `servingPrevious`; never the body or the token.
- **Task 2.** The volume copy step reads the daemon start
  (`dockerDaemonStart`: `docker network inspect bridge --format '{{.Id}}
  {{.Created}}'`) before its helper runs, and again when the helper ends
  without reporting. A changed start, or no answer afterwards, is
  `daemon-unavailable`; the same start is `helper-failed` with no history
  lookup; an unreadable start falls back to the `die` lookup. Each such
  failure logs `replacement.copy-helper-unreported` (exit status, start
  comparison, history lookup, outcome). Rollback is unchanged, so the
  original set is kept.

## Outstanding work

- Task 3: a green scheduled run of Container live qualification on `main`
  on linux-x64 and linux-arm64, and then the dependent to-dos above updated.

## Assumptions and decisions

### Task 1: a dedicated, qualification-named variable

Chose `ORKESTRATOR_QUALIFICATION_GITHUB_META_TOKEN`, read only by the ranges
fetch, rather than reusing `GH_TOKEN` or `GITHUB_TOKEN`. Those are commonly
set in a developer's or a runner's environment, so reading them would make a
production backend authenticate whenever its parent shell had one, against
the user's 2026-11-14 decision that the fetch stays anonymous (7549 task 2).
A blank value is no opt-in.

### Task 1: log only failures

The log line is written once per fetch that produced no seed, not on
success and not when the five-minute back-off skips the fetch, so a healthy
host writes nothing new. `rate-limited` is a 403 or 429 whose
`x-ratelimit-remaining` header is `0`, so a spent quota is told apart from
other refusals.

### Task 1: verify HTTPS reachability after the seed is written

The container's anonymous probe accepts HTTP 2xx, 403 and 429. The seed
assertion already verifies the backend's metadata fetch, and a quota
response proves that the container reached GitHub over HTTPS. Curl
transport errors still fail the probe. The job token stays with the
backend fetch.

### Task 2: the default bridge network as the daemon start

Docker has no daemon start time in its API. The default bridge network's ID
and creation time are recreated at every daemon start (moby source), are
readable on Linux Engine, rootless and Docker Desktop, and need no host
access. A host process start time (`/proc`, `systemctl`) was not used: it
works only when the backend shares the daemon's host and init system. Under
live-restore with surviving containers the network is kept, so a restart
there reads as the same start; it also keeps the helper alive, so the copy
does not fail that way.

### Task 2: any unreported helper exit, volume steps only

The start comparison applies to every `helper-failed` volume step whatever
its exit status (a graceful restart can end the attached run with 125 as
well as a signal). A helper that reported its own failure keeps its reason.
Streamed (legacy layout) steps are unchanged: they have their own outage
detection, and adding two Docker calls to each of their many steps was not
needed for C15.

### Task 2: not proven live here

The bridge recreation was taken from moby's source and not observed on this
branch, because the build host may not restart its daemon. Unit tests in
`apps/backend/tests/container-replacement.test.ts` simulate the start
change; the C15 step on GitHub's runners is the live check (task 3).

## Related

- [Container qualification](../../development/container-qualification.md)
- [7549-rootless-docker-cp-refusals.md](7549-rootless-docker-cp-refusals.md) (the seed bind)
