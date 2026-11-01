# Cursor session status waits on Cursor's account lookup with no bound

`GET /session/:id/status` on the Cursor bridge, for a session with no attached
agent, calls `authStatus()` (`bridges/cursor-bridge/src/credentials.ts:101`),
which calls `Cursor.me` for the account label with no timeout. A slow or
unreachable Cursor API holds the status route until the request gives up.
Found on 2026-10-31 while fixing flake
[0182](../../tests/flaky-tests/agent-bridges/0182-cursor-auth-readiness-aggregate-timeout.md)
in [0030](../cross-cutting/0030-test-suite-and-ci-health.md).

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`.

### Tasks

1. **Bound the account lookup**. Status: done (2026-11-01). A lookup that
   misses 3 s leaves the session ready and labelled with the stored email or
   "Cursor account"; proved against a stubbed `Cursor.me` that never answers.
   A live run on a signed-in bridge with Cursor's API blocked is left (see
   Needs verification).

### 1. Bound the account lookup

**Problem.** The backend reads a Cursor session's readiness from this route.
When Cursor's API is slow, the read hangs, and so does whatever waits on it.

**Context.** `credentials.ts:132` awaits `cursorMe({ apiKey })` before it can
answer, only to build a display label; the result is cached for
`AUTH_CACHE_TTL_MS`. The model catalogue read beside it is bounded
(`CATALOG_TIMEOUT_MS`, 30 s, `models.ts:96`).

**Investigation.** In a network namespace where non-loopback connections hang,
the HTTP contract tests' status requests never returned until the tests
stubbed the credential runtime (0182's section of 2026-10-31).

**Decisions.**

- **How?**
  - **Bound the lookup (a few seconds) and fall back to the stored email or
    "Cursor account", without caching the fallback (recommended).**
    - Pros: readiness never waits on a label; the label recovers on the next read.
    - Cons: a slow API shows the generic label for a while.
  - **Answer readiness without the lookup and fetch the label in the background.**
    - Pros: no wait at all.
    - Cons: more state; the first status has no label.

**Outcome (2026-11-01).** Rechecked on `main` at `93b99bfba`: still
unbounded. `authStatus` now waits at most `ACCOUNT_LOOKUP_TIMEOUT_MS` (3 s,
`config.ts`) for the label. Every read for the same key shares the one
outstanding lookup, because `Cursor.me` takes no signal and a hung request
cannot be cancelled. A missed bound is not cached; a lookup that answers, or
fails, within the bound is cached for `AUTH_CACHE_TTL_MS` as before. Tests:
`credentials.test.ts` ("a lookup that never answers…") and `http.test.ts`
("a hung account lookup neither holds status nor signs the session out").
Both fail without the fix: the first hits Bun's 5 s test timeout, the second
its 2 s request deadline. The behaviour is recorded in
[agent accounts](../../architecture/agent-accounts.md#sign-in-readiness).

## Current state

Bounded at 3 s with an uncached fallback label (2026-11-01). Only the live
check below is left.

## Outstanding work

### Code

- None.

### Live

1. With a real signed-in Cursor bridge and Cursor's API unreachable (for
   example a firewall rule on `api2.cursor.sh`), open a Cursor tab: status
   answers in about 3 s, the tab is not locked, and Settings › Cursor shows the
   stored email or "Cursor account". Not run: the build that fixed this was
   not allowed to reach Cursor or use a real login.

## Constraints and rationale

- A signed-in state must stay signed-in when only the label lookup fails.

## Assumptions and decisions

- 2026-10-31: a separate file, as the README requires for new work.
- 2026-11-01: followed the recommended option (bound plus uncached fallback).
  The background-fetch option needs more state and gives the first status no
  label, for no gain once the wait is a few seconds.
- 2026-11-01: the bound is 3 s, the "few seconds" the recommendation named.
  It is a constant, not an environment setting; tests shorten it through
  `useCursorCredentialRuntimeForTests({ meTimeoutMs })`.
- 2026-11-01: concurrent reads share one in-flight lookup, so a hung API
  holds one request, not one per status poll. The shared lookup is dropped
  on logout and when the test runtime is swapped.
- 2026-11-01: only a missed bound goes uncached. A lookup that fails fast is
  still cached for 15 s, as before, so an API that is down and refusing is
  not asked on every read.
- 2026-11-01: the file stays open (Finished: No, re-rated Low) for the live
  check, rather than being deleted now that the code item is done.

## Open questions

- None.

## Needs verification

- Done (2026-11-01): the backend's readiness read (`interactiveSnapshot` in
  `apps/backend/src/core/http-bridge-provider.ts`) uses `bridgeFetch`'s
  default 30 s deadline (`DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS`,
  `http-bridge-transport.ts`), so the 3 s bound sits well inside it.
- The live check under Outstanding work.

## Related

- [0030](../cross-cutting/0030-test-suite-and-ci-health.md), flake 0182.

## Replaces

- Nothing.
