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

1. **Bound the account lookup**. Status: open.

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

## Current state

Unbounded on `main`.

## Outstanding work

### Code

1. The bound and fallback, with a test whose `me` never resolves.

## Constraints and rationale

- A signed-in state must stay signed-in when only the label lookup fails.

## Assumptions and decisions

- 2026-10-31: a separate file, as the README requires for new work.

## Open questions

- None.

## Needs verification

- How long the backend's readiness read waits before it gives up today.

## Related

- [0030](../cross-cutting/0030-test-suite-and-ci-health.md), flake 0182.

## Replaces

- Nothing.
