# Container live qualification CI is red on every run (C15 and unseeded C23)

## Task analysis

Analysed 2026-11-23 against `main` at `307d19317`. Found while validating
pull request #2541 (Antigravity), which changes neither case's code path.

### Tasks

1. **Make the unseeded C23 case independent of the runner's shared GitHub quota**. Status: open.
2. **Make C15 classify a graceful daemon restart during the copy as `daemon-unavailable` on GitHub's runners**. Status: open.
3. **Get one green Container live qualification run on both architectures**. Status: open (depends on 1 and 2).

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
swallows the failure without a log line, so the CI log cannot say whether
it was a 403, a timeout or a malformed answer.

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

**Decisions.**

- **Where should the fix go?**
  - **Record the helper's exit status and the daemon's start time before and after the copy, and treat a changed daemon start time as an outage (recommended).**
    - Pros: independent of event history eviction and of connection wording.
    - Cons: one more `docker info` call around each copy.
  - **Relax the test to accept `helper-failed` on a graceful restart.**
    - Pros: green at once.
    - Cons: the user would be told to inspect a failed copy that was really a daemon restart.

### 3. Get one green Container live qualification run on both architectures

**Problem.** Several to-dos in this folder (6101, 6820, 7420, 7770, 0729,
0870) wait on a green or complete run of this workflow.

**Context.** The workflow is not a required check, so pull requests merge
with it red; AGENTS.md asks for a green rerun or a recorded reason.

**Investigation.** None beyond tasks 1 and 2.

**Decisions.**

- **When to close this file?**
  - **After a scheduled run on `main` passes on both architectures (recommended).**
    - Pros: proves the fix, not one lucky rerun.
    - Cons: waits up to a week.
  - **After one green pull-request run.**
    - Pros: sooner.
    - Cons: a pull request runs only when its paths match.

## Related

- [Container qualification](../../development/container-qualification.md)
- [7549-rootless-docker-cp-refusals.md](7549-rootless-docker-cp-refusals.md) (the seed bind)
