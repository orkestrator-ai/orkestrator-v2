# A slow remote stops a typed coordinator message from fast-forwarding the checkout

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3`. Rewritten 2026-11-06
against `main` at `e6c3da89` to hold only its live check: the three code tasks
(the `checkout.message-check` log line, the fast-forward to an upstream that is
already fetched, and held mail no longer spending the mail cooldown) are done
and documented in
[`coordinator.md`](../../architecture/coordinator.md). No existing live-evidence
to-do covers coordinator checkout sync, so the check stays here.

### Tasks

1. **Live run against a slow remote**: a typed message and a mail to a coordinator whose remote is slow fast-forward the checkout to the upstream it has already fetched. Status: open (needs a disposable profile with a real coordinator).

### 1. Live run against a slow remote

**Problem.** On 2026-11-04 a message typed to the main coordinator of
`arkaydeus/dd-tools-web` did not fast-forward a checkout that was two commits
behind an `origin/main` it had already fetched. GitHub SSH from that host took
between 3 and 43 s, so the fetch outlasted the panel's 5 s bound. The fix is on
for every coordinator message but has only unit and real-Git evidence.

**Context.** The backend bounds its own fetch at 3 s, then merges the exact
commit it checked with a local fast-forward and answers `fast-forwarded`
(`checkUpstreamBeforeMessage` in `coordinator-message-upstream.ts`,
`ProjectGitService.fastForwardToFetchedUpstream`). Mail takes the same fallback
after a slow or failed fetch and logs `outcome=fast-forwarded-fetched`
(`coordinator-mail-upstream.ts`). A mail held behind a running turn no longer
spends the 60 s mail cooldown.

**Investigation.** Covered so far by unit tests
(`coordinator-mail-upstream.test.ts`) and a real-Git integration test with a
hanging SSH command (`project-git-fetched-fast-forward.integration.test.ts`,
slow tier). Steps:

1. On a disposable `dev:test` profile with a real provider coordinator, pick a
   project whose checkout is clean and behind an `origin/main` that is already
   fetched.
2. Make the remote slow: a `GIT_SSH_COMMAND` that sleeps more than 3 s before
   running `ssh`, set for that profile's backend only.
3. Type a message to the main coordinator. Check for
   `checkout.message-check outcome=fast-forwarded fetch=timed-out` in the
   backend log, a new `HEAD` reflog entry, and that the header no longer says
   "N commits behind".
4. Send it mail while a turn runs. Check for
   `checkout.mail-follow outcome=fast-forwarded-fetched`, and that the held
   mail, redelivered when the turn ends, is not answered `cooldown`.

**Decisions.**

- **How to make the remote slow?**
  - **A sleeping `GIT_SSH_COMMAND` on the test profile only (recommended).**
    - Pros: repeatable; touches no real remote or host SSH configuration.
    - Cons: a delay before SSH starts is not quite a slow GitHub handshake.
  - **Wait for GitHub SSH to be slow again.**
    - Pros: the real failure.
    - Cons: cannot be scheduled.

## Related

- [`coordinator.md`](../../architecture/coordinator.md), checkout sync before a
  message.

## Replaces

This file's own earlier version (2026-11-04), which held the incident
evidence and the three code tasks; git history keeps it. Two of its
verification items were dropped on 2026-11-06: how long the 09:55 UTC check
took cannot be recovered, and how slow GitHub SSH is from one host is an
observation, not a check.
