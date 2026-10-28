# First-prompt naming retries `codex exec` every 30 seconds when Codex cannot sign in

Checked against `main` at `1d1f0a87` (2026-10-28). Fixed on 2026-10-28
against `main` at `79f3bc97`; see Current state.

When an environment is launched with a first prompt, the backend names it by
running `codex exec` (`generateEnvironmentNameWithCodexExec`,
`apps/backend/src/core/commands-agent-support.ts`). If that fails, the
environment keeps its pending rename intent and the `pending-renames`
recurring job retries it about every 30 seconds while the environment runs
(`pendingEnvironmentRenameTask` in `apps/backend/src/core/commands-registry.ts`).
For a user whose Codex is signed out, missing or offline, every retry spawns a
Codex process that fails the same way. Feature-build naming instead falls back
to a local title after one failure (`refineFeatureTitle` in
`apps/backend/src/core/feature-build.ts`). Split from the open question in
[0731-ci-backend-test-spawns-real-codex.md](0731-ci-backend-test-spawns-real-codex.md),
which made the failure log content-free and logs repeats only as a count.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`. The file was split without
an analysis, so the options below were written by the implementer and the
recommended option was taken.

### Tasks

1. **Choose a retry policy for failures that will not fix themselves**: stop, back off further, or fall back to a local slug; and whether the user sees it. Status: done (2026-10-28).
2. **Implement it with a test using a failing stub `codex`**. Status: done (2026-10-28).

### 1. Choose a retry policy

**Problem.** A failed first-prompt rename retries every 30 seconds with no
upper bound while the environment runs, so a signed-out, missing or offline
Codex is spawned about 2,880 times a day per environment.

**Context.** Naming is cosmetic and must not block a launch or a prompt. A
user who signs in later should still get a generated name while the
environment keeps its generated timestamp name. Feature-build naming writes a
local title at creation and refines it once with Codex.

**Investigation.** Confirmed from code.
- The retry time is in memory (`pendingEnvironmentRenameRetryAt`,
  `commands-registry.ts`), set to `Date.now() + 30_000` on every failure. The
  `pending-renames` job runs every 2 s while any environment holds an intent
  (`apps/backend/src/core/index.ts`, job `pending-renames`) and skips an
  environment until its retry time.
- `PendingRenameFailureLog` already counts consecutive failures per
  environment and intent, resets on a new intent or a success, and is pruned
  for environments without an intent.
- The failure classes do not separate "will not fix itself" from "transient".
  `command-missing` and `command-timed-out` are reliable, but a refused login,
  a rate limit, a 5xx and a dropped network all reach the backend as a
  non-zero `codex exec` exit, which `summarizePendingRenameFailure` reports as
  `command-failed`. Codex's stderr would tell them apart, but it repeats the
  prompt and is deliberately not read (0731, AGENTS.md invariant 12).
- A missing binary is not permanent either: the managed toolchain can install
  Codex later, and the lookup falls back to `codex` on `PATH`.
- Sign-in usually happens outside the app (`codex login` in a terminal, or
  another tool writing `~/.codex/auth.json`), so the backend has no reliable
  "Codex signed in" signal to reset a backoff on.
- A session's first prompt already clears the retry time
  (`prepareEnvironmentFirstPrompt`, called from the native, tmux and
  prompt-queue paths), so a user who opens a new tab gets an immediate retry.

**Decisions.**

- **What should a failure that may not fix itself do?**
  - **Back off exponentially per environment and intent: 30 s, doubling, capped at 30 min, for every failure class (recommended).**
    - Pros: about 54 spawns a day instead of about 2,880; never gives up, so a later sign-in or install is picked up within 30 min with no reset signal; no product-visible change; uses the count the failure log already keeps.
    - Cons: a user who signs in waits up to 30 min (or until the next first prompt in a new tab); still a few spawns an hour for a user who never signs in.
  - **Stop retrying after N failures of `command-missing` or `command-failed`.**
    - Pros: zero spawns once given up.
    - Cons: `command-failed` also covers transient outages, so a short network blip would end naming for good; a later sign-in never names the environment, against the constraint, unless a reset signal is added that the backend does not have.
  - **Fall back to a local slug from the prompt after the first failure.**
    - Pros: the environment gets a readable name at once, with no further spawns.
    - Cons: see the next decision; also ends naming for good, because a local slug is not a generated name.
- **Local slug, or keep the generated timestamp name?** (the open question)
  - **Keep the timestamp name (recommended).**
    - Pros: branch names are pushed to the user's remote; a slug cut from raw prompt text can carry words the user never meant to publish, which Codex's summarised slug avoids; keeps the later-sign-in path.
    - Cons: the environment keeps an unreadable name until naming succeeds.
  - **Use a local slug like feature-build.**
    - Pros: readable at once.
    - Cons: as above; and feature-build titles are local Kanban labels, not pushed branch names.
- **Should the user see that naming gave up?**
  - **No new signal (recommended).** With the backoff, naming never gives up; the timestamp name is the visible state, and the backend log keeps the content-free first-failure line and the power-of-two counts.
    - Pros: no protocol or renderer change for a cosmetic feature.
    - Cons: a signed-out user is not told why the name did not change.
  - **Emit an event the renderer shows as a hint ("sign in to Codex to name environments").**
    - Pros: explains the timestamp name.
    - Cons: a new event, renderer state and copy; the backend cannot tell a refused login from an outage, so the hint could be wrong.

### 2. Implement it with a test using a failing stub `codex`

**Problem.** The backoff needs a test that fails on the fixed 30-second retry.

**Context.** `tests/commands-registry-environments-create.test.ts` already
drives `reconcile_pending_environment_renames` with `withFakeCodex` stubs and
a mocked `Date.now`.

**Investigation.** Done; see Current state.

**Decisions.**

- **Where does the delay live?**
  - **A pure `pendingRenameRetryDelayMs(failures)` beside `PendingRenameFailureLog`, whose `failed()` now returns the consecutive count (recommended).**
    - Pros: one count for both logging and backoff, so they cannot disagree; the schedule is unit-tested without spawning.
    - Cons: the log class now feeds retry timing as well as logging.
  - **A second per-environment count map in the registry.**
    - Pros: keeps the log class log-only.
    - Cons: two counts with their own reset and pruning rules.

## Current state

Fixed on 2026-10-28.

- `pendingRenameRetryDelayMs` (`apps/backend/src/core/pending-rename-failure-log.ts`)
  returns 30 s after the first failure, then doubles (60 s, 2 min, 4 min,
  8 min, 16 min) and caps at 30 min (`PENDING_RENAME_RETRY_MAX_MS`).
  `PendingRenameFailureLog.failed()` returns the consecutive failure count for
  the environment's current intent; a new intent, a successful rename or
  pruning starts again at one.
- `pendingEnvironmentRenameTask` (`commands-registry.ts`) sets the retry time
  from that count instead of a flat 30 s. The intent and the generated name
  are kept, so naming still succeeds after a later sign-in; a session's first
  prompt still retries at once and, on failure, continues the backoff rather
  than restarting it. The backoff is in memory, so a backend restart starts it
  again at 30 s.
- Tests:
  - `pending-rename-failure-log.test.ts`: the delay schedule and cap, and the
    count `failed()` returns across intents, environments and a success.
  - `tests/commands-registry-environments-create.test.ts` "backs off a
    signed-out Codex from 30 seconds to a 30-minute cap and keeps the intent":
    a stub `codex` that prints a 401 line and exits 1 on every call; nine
    failures, checking 1 ms before each retry time that no spawn happens and
    at the retry time that exactly one does (30 s ... 30 min, 30 min); the
    name and intent are unchanged; the log has one full line and counts at
    the 2nd, 4th and 8th failure, with no prompt text.
  - Failing first: with the retry time set back to a flat 30 s, the new
    registry test fails (`Expected: 2, Received: 3` at the 60 s step).
  - The existing 30-second, explicit-first-prompt and recovery tests still
    pass unchanged.
- [recurring-work.md](../../architecture/recurring-work.md) B09 documents the
  backoff.

## Outstanding work

### Code

1. **Done (2026-10-28):** retry policy chosen (capped exponential backoff,
   timestamp name kept, no user-visible signal); see Assumptions and
   decisions.
2. **Done (2026-10-28):** implemented with unit tests and a registry test
   using a signed-out stub `codex`.

### Qualification

- None beyond the unit and command-registry tests.

## Constraints and rationale

- Naming is cosmetic; it must never block a launch or a prompt.
- Logs never contain prompts (AGENTS.md invariant 12).
- A user who signs in to Codex later should still get a generated name if the
  environment is still on its generated name, unless the choice says otherwise.

## Assumptions and decisions

1. **Task 1, retry policy: capped exponential backoff for every failure class
   (2026-10-28).** Options: (a) back off from 30 s, doubling, to a 30 min cap;
   (b) stop after N failures of `command-missing` or `command-failed`;
   (c) fall back to a local slug. Chose (a). The failure summary cannot tell a
   refused login from a transient outage (both are `command-failed`), and the
   backend has no signal for a later sign-in, so stopping would end naming for
   good after a network blip and would break the sign-in-later constraint.
   The cap of 30 min bounds both the spawn rate (about 54 a day per running
   environment) and how long a newly signed-in user waits. Assumes a few
   short `codex exec` spawns an hour is acceptable for a user who never signs
   in.
2. **Task 1, open question: keep the generated timestamp name, no local slug
   (2026-10-28).** Branch names follow environment names and are pushed to the
   user's remote; a slug cut from the raw prompt could publish words the user
   did not mean to, and it would end the later-sign-in path. Feature-build's
   fallback is a local Kanban title, not a pushed branch, so its precedent
   does not carry over.
3. **Task 1, user signal: none (2026-10-28).** Naming never gives up under
   the chosen policy, the backend cannot say reliably that the cause is a
   login, and a hint would need a new event and renderer state for a cosmetic
   feature. The content-free log lines from 0731 remain the diagnostic.
4. **Task 2, where the delay lives: `pendingRenameRetryDelayMs` beside
   `PendingRenameFailureLog`, fed by the count `failed()` now returns
   (2026-10-28).** One count drives both the log and the retry time, so they
   share their reset rules (new intent, success, pruning).
5. **Task 2, explicit first prompt keeps the count (2026-10-28).** A
   session's first prompt still clears the retry time and retries at once
   (existing behaviour), but a failure then continues the backoff from the
   intent's count instead of restarting at 30 s, so opening tabs cannot reset
   it.

## Open questions

- None. The local-slug question is answered in Assumptions and decisions 2.

## Needs verification

- How often this happens for real users: no rename failure lines were found in
  this host's app logs for 2026-10-25 to 2026-10-27 (from 0731's analysis).
  Not checked again: it needs real users' logs, not a test, and no longer
  decides the fix. The first-failure line and its counts
  (`Environment rename from pending prompt is still failing`) show it in a
  support log if it matters later.

## Related

- [0731-ci-backend-test-spawns-real-codex.md](0731-ci-backend-test-spawns-real-codex.md): where this was split from.

## Replaces

Nothing; new on 2026-10-28.
