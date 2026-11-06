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

1. On a disposable `dev:test --fixture` profile with a real provider coordinator,
   prepare two independent fixture projects. In each disposable coordinator
   checkout that the backend fetches, save the original local `origin` URL and
   install a separate executable SSH shim under that profile's scratch directory.
   Each shim serves only its own saved local bare repository with
   `exec git-upload-pack <saved-bare-repository-path>` (quote the actual path).
   It records an invocation count, without arguments or repository contents, and
   sleeps 15 s first only while its profile-scoped delay marker exists. Set
   `git config core.sshCommand <absolute-shim-path>` and
   `git config ssh.variant simple` in each checkout, then explicitly switch
   their origins with `git remote set-url origin ssh://git@slow.invalid/repo.git`.
   This forces Git through the shim instead of bypassing SSH for a filesystem
   origin; no real SSH server or network connection is needed. With the delay
   markers absent, fetch each origin successfully and confirm both invocation
   counts increase, proving each shim serves the correct repository.
   On the mail project's coordinator,
   start a bounded read-only turn while its checkout is current, before making
   it behind: starting that turn must not consume the fast-forward under test.
   Then advance each disposable remote and fetch its configured base branch's
   upstream without merging. Each checkout must now be clean and behind that
   fetched upstream. Record each starting `HEAD` and upstream commit. Use one
   for typed send and one for mail; do not reuse the advanced typed checkout.
2. Create both profile-scoped delay markers. Keep them present through both
   scenarios: 15 s exceeds the typed path's 3 s fetch bound and the mail path's
   5 s wait. For each scenario below, confirm its shim's invocation count
   increases and the fetch stays pending past the bound before the fallback
   runs. A fast transport failure does not qualify the timeout path.
3. Type a message to the main coordinator. Check for
   `checkout.message-check outcome=fast-forwarded fetch=timed-out` in the
   backend log, a new `HEAD` reflog entry, and that the header no longer says
   "N commits behind".
4. On the second project's coordinator, send mail while the already-started
   turn still runs. Confirm the checkout is still behind its recorded fetched
   upstream and the mail is held. Let the turn end with the remote delay still
   active. Check for `checkout.mail-follow outcome=fast-forwarded-fetched`, a
   new `HEAD` reflog entry at that upstream, and that the redelivered mail is
   not answered `cooldown`.
5. Remove both delay markers, let the owned delayed fetches settle, restore each
   saved origin URL and unset the checkout-local `core.sshCommand` and
   `ssh.variant` settings. Then stop and reset the disposable profile, including
   its scratch shims. Do not change host SSH or global Git configuration.

**Decisions.**

- **How to make the remote slow?**
  - **SSH origins served by delayed, checkout-local shims (recommended).**
    - Pros: repeatable; forces SSH transport while serving only disposable local
      repositories; touches no host SSH or global Git configuration.
    - Cons: simulates a slow handshake and needs a shim per fixture repository.
  - **Wait for GitHub SSH to be slow again.**
    - Pros: the real failure.
    - Cons: cannot be scheduled.

## Assumptions and decisions

### Task 1: independent checkout state and fetch deadlines (2026-11-06)

Use two fixture projects instead of resetting an advanced checkout: each scenario
starts behind without discarding work. A 15 s delay exceeds both deadlines; the
run must observe the timeout and merge independently. This repairs the procedure,
not its still-open live qualification.

### Task 1: force the SSH transport before delaying it (2026-11-06)

Use explicit SSH origins and checkout-local `core.sshCommand` shims, matching
the real-Git integration test's transport setup. A backend-only
`GIT_SSH_COMMAND` would leave a filesystem origin unchanged and never run.
The shims serve the saved local bare repositories, so the undelayed baseline
must succeed before the delay markers are enabled. Invocation counts and a
fetch pending past its bound are required evidence in both scenarios. The
live coordinator run remains open.

## Related

- [`coordinator.md`](../../architecture/coordinator.md), checkout sync before a
  message.

## Replaces

This file's own earlier version (2026-11-04), which held the incident
evidence and the three code tasks; git history keeps it. Two of its
verification items were dropped on 2026-11-06: how long the 09:55 UTC check
took cannot be recovered, and how slow GitHub SSH is from one host is an
observation, not a check.
