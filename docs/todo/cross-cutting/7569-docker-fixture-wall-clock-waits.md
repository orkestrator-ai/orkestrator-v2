# Docker fixture specs: fixed waits that set the suite's wall clock

## Task analysis

Analysed 2026-11-10 against `main` at `2aad83a37`. `mise run test:agent:docker:isolated`
now overlaps the image smoke, the image qualification and profile startup, and
runs the `Docker fixture` specs in two profiles side by side
(`DOCKER_FIXTURE_SHARDS` in `apps/desktop/scripts/dev/isolated-browser.ts`).
Each shard is now bounded by its slowest spec files, and the three slowest
spend most of their time in fixed waits rather than in work. This file
collects those waits.

### Tasks

1. **Replace the Files panel's 6 s inactive-environment sleep with an observed wait.** Status: open.
2. **Shorten the Files panel's 18 s hidden-document window without weakening it.** Status: open.
3. **Stop the annotation evidence spec waiting out a 300 s garbage-collection period.** Status: open.
4. **Find where the coordinator view spec spends its 120–150 s.** Status: open.

### 1. Replace the Files panel's 6 s inactive-environment sleep with an observed wait

**Problem.** `container-files-wiring.spec.ts`, step "a change made while
another environment is open shows on return", writes a file in the container
and then calls `page.waitForTimeout(6_000)` before switching back. The sleep
exists so the backend has scanned the change while the container environment
is inactive. It always costs 6 s, and on a slow host it does not guarantee the
scan happened.

**Context.** The file averaged 207 s over three Docker runs on 2026-11-10 (the
`…091915-d2ae3979aef1` worktree's `output/agent-testing/qa-browser-*/browser/results.json`:
360 s, 116 s and 119 s for its main test, the first a failure). The backend
scans container worktrees on its own clock (15 s interval, per the comment in
the hidden-document step) and pushes a revision. AGENTS.md's inactive
environment rule needs the change to land while the environment is not shown;
it does not need a fixed delay.

**Investigation.** Not yet measured how long the scan takes after the write. The
step's assertion after returning (`toBeVisible({ timeout: POLL_BUDGET_MS })`)
already tolerates a scan that finishes after the switch, so the sleep only
makes it more likely that the scan finished *while inactive*, which is what
the step claims to test.

**Decisions.**

- Wait on the backend's change projection for the container (through the
  CLI or the invoke API the spec already uses) until it lists the file, then
  switch back. (recommended)
  - Pros: proves the change arrived while the environment was inactive, which
    the sleep only assumes; usually faster than 6 s; no product change.
  - Cons: needs a helper that reads the projection without opening the
    environment in the page, which must not count as a page poll.
- Keep the sleep and shorten it to 2 s.
  - Pros: trivial.
  - Cons: still a guess; makes the "while inactive" claim weaker, not stronger.

### 2. Shorten the Files panel's 18 s hidden-document window without weakening it

**Problem.** Step "a hidden document pauses the All files poll and catches up
on return" sleeps 1 s and then 18 s while hidden, and asserts the page sent
no tree poll. This is a negative check: it proves that something did *not*
happen, so it cannot become a condition wait.

**Context.** The 18 s is "three poll intervals, past the container tree's 10 s
cache". Both the page poll interval and the tree cache are product constants.

**Investigation.** Not yet checked whether the poll interval or the cache TTL
can be set for an agent-test profile.

**Decisions.**

- Let an agent-test profile set the All files poll interval and the tree
  cache TTL (for example 1 s and 2 s), and size the window from them. (recommended)
  - Pros: keeps "three intervals past the cache" exactly, in about 6 s.
  - Cons: a test-only knob in product code; the spec must read the values it
    runs with, not assume them.
- Drive the page's timers with Playwright's clock (`page.clock`).
  - Pros: no product change.
  - Cons: the tree cache is in the backend, which the page clock does not
    move; only the page half of the claim would be tested.
- Leave it.
  - Pros: no risk.
  - Cons: 19 s on every run, in the slowest file.

### 3. Stop the annotation evidence spec waiting out a 300 s garbage-collection period

**Problem.** `web-annotations-gateway.spec.ts`, test "Docker fixture writes
annotation evidence inside the container, checks paths there, and removes it
after settlement", waits for settled evidence to be removed. Removal runs on
the reconciler's garbage-collection pass, every `GC_EVERY_TICKS = 100` ticks
of 3 s (`apps/backend/src/core/web-annotation-service-requests.ts:75`,
called at line 1419), so the test can wait up to 300 s. It took 68–203 s in
the three runs above, and its timeout is 9 minutes.

**Context.** The scheduler's ten-minute no-progress allowance for
`test:agent:docker:isolated` (`.orkestrator-test-scheduler.json`) exists for
this wait (`docs/development/agent-testing.md`).

**Investigation.** Where the reconciler's tick count starts relative to the
test is what makes the duration vary; not otherwise investigated.

**Decisions.**

- Let an agent-test profile set `GC_EVERY_TICKS` (or the period) through an
  environment variable the backend reads only for agent-test profiles.
  (recommended)
  - Pros: the real collection path still runs, on its real trigger, just
    sooner; the test's timeout and the scheduler's allowance can then drop.
  - Cons: a test-only knob; it must be impossible to set in production.
- Add a test-only command that runs `collectAllGarbage()` now.
  - Pros: deterministic and immediate.
  - Cons: tests the collection, not the schedule that runs it; a new command
    surface.
- Leave it.
  - Pros: no risk.
  - Cons: up to 5 minutes in one shard on every run.

### 4. Find where the coordinator view spec spends its 120–150 s

**Problem.** `container-app-wiring.spec.ts`, test "Docker fixture coordinator
view follows delegations and context across switch, hidden document, reload
and two windows", took 121–148 s in the three runs. It is now the long pole
of its shard with the annotation spec.

**Context.** Not investigated. The test has a 5–6 minute timeout and several
30–60 s expectations.

**Investigation.** None yet. Start with its Playwright trace or per-step
timings (`test.step` durations in `results.json`).

**Decisions.**

- Profile it first and file its waits here as further tasks. (recommended)
  - Pros: no change without evidence.
  - Cons: one more run.

## Current state

`DOCKER_FIXTURE_SHARDS` puts `container-files-wiring.spec.ts` in shard 1 and
`container-app-wiring.spec.ts` with `web-annotations-gateway.spec.ts` in
shard 2, about 380 s each by the 2026-11-10 averages. Shortening any of these
waits shortens its shard; once a shard changes by more than a minute,
rebalance the split.

The first sharded run (2026-11-10, beelink, image build cached) took 527 s
for the whole task, against 665–902 s for the Playwright phase alone in the
three serial runs above. Both profiles were ready 46 s after the task started.
Shard 1 took 252 s; shard 2 took 474 s because the annotation evidence spec
took 274 s (task 3's wait), so that one wait now sets the task's wall clock.

## Constraints and rationale

- A wait that proves something did *not* happen (task 2) stays a timed
  window; make the window smaller, never replace it with a condition.
- Test-only knobs must not be settable outside agent-test profiles.
- Do not loosen an assertion to save time (AGENTS.md, flaky tests).

## Related

- [`docs/development/agent-testing.md`](../../development/agent-testing.md):
  the `test:agent:docker:isolated` description.
- `apps/desktop/scripts/dev/isolated-browser.ts`: the shards and the overlap.
