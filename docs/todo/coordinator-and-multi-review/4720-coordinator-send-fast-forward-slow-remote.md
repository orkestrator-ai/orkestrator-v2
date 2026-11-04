# A slow remote stops a typed coordinator message from fast-forwarding the checkout

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3`.

### Tasks

1. **Log the typed-path check**: `check_coordinator_upstream_merge` records its outcome and how long it took. Status: open.
2. **Fast-forward to the already-fetched upstream when the fetch is slow**: a checkout that is behind a remote-tracking ref it already has is merged even when the fresh fetch outlasts the panel's bound. Status: open.
3. **Mail held behind a running turn spent the mail cooldown**: the redelivery when the turn ended skipped its fast-forward. Status: done (2026-11-04).

### 1. Log the typed-path check

**Problem.** On 2026-11-04 at 09:56 UTC a message typed to the main coordinator of `arkaydeus/dd-tools-web` did not fast-forward the checkout, and the header still said "main · 2 commits behind". Nothing in the backend log records what `check_coordinator_upstream_merge` did for that send. The cause had to be inferred from the mail path's `checkout.mail-follow` line, the checkout's ref mtimes and SSH timings taken afterwards.

**Context.** The mail path logs `checkout.mail-follow` for `fast-forwarded`, `timed-out` and `failed` (`apps/backend/src/core/coordinator-mail-upstream.ts`). The typed path is `check_coordinator_upstream_merge` (`apps/backend/src/core/commands-registry-client-state.ts`), which waits for `ProjectGitService.fetch`, plus the panel's 5 s race in `confirmUpstreamMerge` (`apps/web/src/components/projects/CoordinatorPanel.tsx`). The panel's timeout happens in the renderer, so the backend never knows the answer arrived too late.

**Investigation.** Evidence from the incident:
- The checkout was clean, on `main`, tracking `origin/main`, `+0 -2`. `origin/main` had been at `720d9f1` since 2026-10-07; the two commits were already fetched. No `HEAD` reflog entry exists after 2026-10-06, so no sync ran.
- The coordinator's bridge was cold (mail had waited as `recipient-cannot-inject` since 01:2x UTC). The typed prompt was accepted at 09:55:59.
- Mail held behind that turn at 09:56:01 (`outcome=held reason=busy`), redelivered at 09:56:33 with no `checkout.mail-follow` line (the cooldown of task 3), and the next mail's attempt at 09:57:06 logged `outcome=timed-out`: its fetch outlasted 5 s.
- The last successful fetch in the checkout (`FETCH_HEAD` and `refs/remotes/origin` mtimes) landed at 09:59:11, about 40 s after a further typed send at 09:58:30.
- SSH authentication to GitHub from this host, measured at about 10:00 UTC, took 2.7, 3.6, 6.4, 8.7, 28 and 43 s; two attempts were refused (`Permission denied (publickey)`) after GitHub took 16 s to answer the first key offered.

So the typed check almost certainly waited on a fetch that took longer than 5 s, the panel sent without merging, and the late fetch only refreshed the header.

**Decisions.**

- **What to record?**
  - **One `checkout.message-check` info line per check with `projectId`, the reason (`offer`, `turn-running`, `not-behind`, `blocked`, `no-status`), whether a fetch ran, and `durationMs` (recommended).**
    - Pros: content-free; answers "was it called, and was it slow" directly; the same shape as `checkout.mail-follow`.
    - Cons: one line per coordinator message.
  - **Log only checks slower than the panel's bound.**
    - Pros: quieter.
    - Cons: does not show that the check ran at all, which was the first question here.

### 2. Fast-forward to the already-fetched upstream when the fetch is slow

**Problem.** The rule is "fast-forward whenever Git can do it cleanly", but the typed check only answers after a fresh fetch. When the remote is slow, a checkout that is already behind its local `origin/main` is left behind, although no network is needed to merge those commits.

**Context.** `ProjectGitService.fetch` reads status first (`before`), which already holds `behind`. `decideUpstreamMergeOffer` runs on the fetched status only. `sync` runs `git pull --ff-only`, which also goes to the network.

**Investigation.** In the incident the two missing commits had been local since 2026-10-07, so a local fast-forward would have given the coordinator current code even with GitHub this slow.

**Decisions.**

- **How to use the known state?**
  - **When the fetch outlasts the bound, fast-forward to the remote-tracking ref already present with a local `merge --ff-only @{upstream}`, then let the late fetch refresh the header (recommended).**
    - Pros: meets the rule whatever the remote's speed; no network in the send path.
    - Cons: a new sync variant to keep under the same busy and blocked gates; the coordinator may still miss commits the slow fetch would have brought.
  - **Keep waiting for the fetch, with a longer bound.**
    - Pros: no new Git path.
    - Cons: holds every message for as long as the remote is slow, which is the cost the bound exists to avoid.

### 3. Mail held behind a running turn spent the mail cooldown

**Problem.** `fastForwardBeforeCoordinatorMail` recorded its 60 s per-project attempt before learning the checkout was busy. Mail held behind the running turn, and redelivered when the turn ended, then answered `cooldown` without trying.

**Context.** `beforeMailInject` runs at the top of `NativeAgentService.dispatchMailInject`, before the hold for a running turn.

**Investigation.** In the incident, the attempt at 09:56:01 returned `busy`, and the delivery at 09:56:33 was skipped by the cooldown. That delivery could have used the status fetched for the typed message.

**Decisions.**

- **How to stop a busy attempt counting?**
  - **Drop the attempt record when the outcome is `busy` (implemented).**
    - Pros: one line; a busy check fetches nothing, and a busy refusal after a fetch is retried cheaply because the fetch has its own cooldown.
    - Cons: none found.
  - **Check `isCheckoutBusy` before recording the attempt.**
    - Pros: explicit.
    - Cons: a second active-turn read per mail, which reads each conversation's projection.

## Assumptions and decisions

### Task 3: drop the record rather than check first

Chose to drop the attempt record on `busy` so the active-turn read runs once per mail. The test "mail held behind a running turn does not spend the cooldown" in `coordinator-mail-upstream.test.ts` fails on the old code (`cooldown`).

## Needs verification

- How long the typed check actually took at 09:55 UTC; nothing logged it (task 1).
- Whether GitHub SSH from arktech-mini is still slow; the measurements above are from 2026-11-04 around 10:00 UTC only.
