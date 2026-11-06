# Leaked host-reachability probe networks: clear omarchy-hp's pre-fix backlog

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da89`. The earlier code and
qualification tasks of this file are finished and removed (see Replaces).
What remains is one live check: the probe-network sweep has never been run
for real on a host with a backlog.

### Tasks

1. **Run the sweep on omarchy-hp's pre-fix backlog**: run `mise run disk:report -- --fix probe-networks` on omarchy-hp, confirm it removes exactly the stale unattached probe networks, and that a new environment network can then be created. Status: open (the user's call; it removes other owners' resources).

### 1. Run the sweep on omarchy-hp's pre-fix backlog

**Problem.** omarchy-hp's rootful Docker daemon held 29 unattached
`ork-<owner>-reach-probe-net` networks on 2026-10-30, all created on
2026-10-28 between 18:22 and 20:20 UTC, before the shutdown fix (#1419)
merged at 01:29 UTC on 2026-10-29. With the bridge network they use all 31
default address pools, so every new environment network fails with
`resource-exhausted`. That blocks three other live runs on that host:
[0020](0020-container-state-observation.md) task 2,
[0729](0729-container-benchmark-target-misses.md) task 5 and
[0870](0870-container-start-poll-quantisation.md) task 3.

**Context.** The sweep is `mise run disk:report -- --fix probe-networks`
(`scripts/probe-network-sweep.ts`; rules in
[disk-usage.md](../../development/disk-usage.md)). It removes, one at a time
by network id, only networks with the `host-reachability-probe` role label, a
name of the exact form `ork-<16 hex>-reach-probe-net`, a readable creation
time over 24 h ago, and no container in any state; anything Docker cannot
answer about is kept. Plain `mise run disk:report` only counts them. The
sweep removes resources other runs created, so running it is the user's
call, not an agent's.

**Investigation.** The sweep's only live check so far (2026-10-31, beelink)
ran on networks that check created itself, with removal guarded to their ids
and the clock moved forward two days. It showed a fresh network is listed but
not stale, and that a network with a created-only container is kept. The
unguarded command has not been run against a real backlog. These networks
predate the fix, so their source is known and needs no owner correlation,
unlike the post-qualification networks on beelink in
[3320](3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md).

Steps:

1. On omarchy-hp, record
   `docker network ls --filter label=orkestrator-resource-role=host-reachability-probe --format '{{.ID}} {{.Name}} {{.CreatedAt}}'`
   and `docker network ls | wc -l`.
2. Run `mise run disk:report` and confirm its `probe networks` row counts the
   backlog and how many are unattached and over a day old.
3. With the user's go-ahead, run `mise run disk:report -- --fix probe-networks`.
4. Repeat step 1. Expect every pre-fix network gone and any network newer
   than a day, or with a container attached, still present.
5. Start a throwaway `dev:test` profile with
   `--fixture-environments local,container` (never the production instance)
   and confirm the container fixture creates its environment network. Then
   `dev:stop` and `dev:reset` it.
6. Record the counts here and unblock 0020 task 2, 0729 task 5 and 0870
   task 3.

**Decisions.**

- **Where should this check live?**
  - **Here, as this file's only task (recommended).**
    - Pros: 0020, 0729 and 0870 already point here as the blocker; the
      backlog's source is known, so it can be cleared now.
    - Cons: one more open file in the index.
  - **As a task in 3320.**
    - Pros: one file for every leaked-probe-network clean-up.
    - Cons: 3320 is about beelink and deliberately clears its networks only
      after its task 1 has read their owners; a different host with a known
      source would wait on that for no reason.
- **Who runs it?**
  - **The user, or an agent with the user's explicit go-ahead (recommended).**
    - Pros: respects the rule that agents do not remove resources other runs
      own.
    - Cons: omarchy-hp's container runs stay blocked until then.
  - **An agent on its own initiative.**
    - Pros: unblocks the three live runs sooner.
    - Cons: removes other owners' resources on the user's machine without
      their approval.

## Current state

- The leak's known sources are fixed: the CLI test and scenario harnesses
  start backends with `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, a SIGTERM'd
  backend removes its own probe network, and `reapStaleProbes`
  (`apps/backend/src/core/container-host-reachability.ts`) removes its own
  owner's unattached probe networks. A full `mise run test`,
  `test:cli:scenarios` and the live Docker suites on beelink left no probe
  network on 2026-10-31.
- `mise run disk:report` counts probe networks of every owner, and
  `--fix probe-networks` removes the stale ones; the rules are in
  [disk-usage.md](../../development/disk-usage.md).
- omarchy-hp's 29 pre-fix networks were last seen on 2026-10-30 and have not
  been touched since.

## Assumptions and decisions

### Task 1: rewriting the file to hold only the live check (2026-11-06)

- **Chose:** keep this file with the omarchy-hp sweep as its one task, and
  remove the five finished tasks.
- **Why:** the retirement of to-dos whose every task is done requires a
  finished file to be deleted unless it still owes a live check. This one
  does: old task 5's sweep has only been checked on networks it created
  itself, and three other to-dos are blocked on clearing this backlog. The
  check does not fit 3320 (see task 1's decisions). `AGENTS.md` also names
  this file as the layout to copy for new to-dos, so it keeps the full
  layout.

## Constraints and rationale

- Removing networks whose owner is not provably dead is unsafe on a shared
  daemon; only the creating run (by its owner label) or an owner's own reaper
  may remove them. The one exception is probe networks that are unattached
  and over a day old, and only through the explicit
  `disk:report -- --fix probe-networks`. They are single-use and hold no data.

## Related

- [3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md](3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md), probe networks that leaked on beelink after this file's fix was qualified.
- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md) (test leaks)
- [0061-container-qualification-follow-ups.md](0061-container-qualification-follow-ups.md) (harness leaks)

## Replaces

This file's own finished tasks, removed on 2026-11-06:

1. Find the leaking run: `cli.test.ts`'s development backend and every
   `test:cli:scenarios` backend (done 2026-10-28, confirmed live on beelink
   2026-10-31 through `0730-cli-tests-leak-probe-networks.md`, also deleted).
2. Harness cleanup: harness backends skip the boot check and a SIGTERM'd
   backend removes its own probe network (done another way, 2026-10-28).
3. The owner reaper also removes networks (done 2026-10-28).
4. Linux qualification: no new probe networks after a full run (done
   2026-10-31, beelink, Docker Engine 29.9.2).
5. The owner-agnostic sweep: `disk:report -- --fix probe-networks` (done
   2026-10-31). Its live run on a real backlog is task 1 above.
