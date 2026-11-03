# The terminal WebSocket rebuilds every channel on every visibility change

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Rebuild only when needed**: stop replacing a healthy socket when the page becomes visible. Status: open.

### 1. Rebuild only when needed

**Problem.** Each return to the page closes the socket and re-subscribes every terminal channel, and each channel then reconciles from a snapshot.

**Context.** The rebuild exists for a real reason: mobile WebViews can keep an apparently open, dead socket while backgrounded (`apps/web/src/lib/native/terminal-websocket-client.ts:361-362`). This transport is opt-in: it is on only when set in `localStorage` or the options (`apps/web/src/lib/native/web-gateway.ts:153-160`).

**Investigation.** `onVisibilityChange` has no condition beyond "visible with channels" (`terminal-websocket-client.ts:359-372`). `resetChannelsForReconnect` clears every channel (`:822`, called at `:370`). A separate path drops a socket when the link goes silent (`dropConnection`, `:378`, called from `web-gateway.ts:851`). The client has no ping or pong frame that I could find, and browser code cannot send a WebSocket ping, so the report's "no frame or pong for X seconds" can only mean "no frame", which a quiet terminal also shows.

**Decisions.**

- **What decides a rebuild?**
  - **Limit the rebuild to mobile hosts and to a page hidden for longer than a short bound (recommended).**
    - Pros: a desktop alt-tab costs nothing; needs no new frame; keeps the protection where the comment says it matters.
    - Cons: a desktop socket silently killed during a short hide waits for the silence path.
  - **Add an application-level echo and rebuild only if it goes unanswered.**
    - Pros: tests the socket directly on every host.
    - Cons: a protocol addition with a version-compatibility entry, and a delay on return while it waits.

## Constraints and rationale

The report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) require missed events to stay detectable; a kept channel must still detect a gap through its revision and generation (`apps/web/src/hooks/useTerminal.ts:485-540`).

## Needs verification

- How many users have turned this transport on. Local windows and default web clients use other paths.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
