# Agent-test profiles run whatever bridge build is on disk

Checked against `main` at `06297124` (2026-10-23).

A `dev:test` profile launches each local bridge from its built
`bridges/<bridge>/dist/index.js` (`getBridgePath` in
`apps/backend/src/core/commands-servers.ts`). Nothing in `dev:test` or the
live suites rebuilds that file or checks that it matches the source. A live
run after a bridge change therefore tests the previous build, silently, and
spends real tokens doing so.

## Current state

- Found on 2026-10-23 while qualifying
  [0054-agent-test-pi-default-model.md](0054-agent-test-pi-default-model.md).
  The first `mise run test:agent:coordinator --credential-source pi` after
  the bridge change ran a `bridges/pi-bridge/dist/index.js` built before it.
  That build did not contain `PI_BRIDGE_DEFAULT_MODEL`. Every turn started on
  the catalogue's first model (`gpt-4`), as if the fix did not exist. After
  `bun run --cwd bridges/pi-bridge build`, the same run started on the host's
  saved default (`gpt-5.5`).
- The backend itself runs from source in a profile, so a change spanning the
  backend and a bridge can look half-applied.
- The passing Pi rerun later on 2026-10-23 built every bridge by hand first
  (each bridge's `build` script, for all five) and checked that
  `bridges/pi-bridge/dist/index.js` contained `PI_BRIDGE_DEFAULT_MODEL`. That
  is still the only guard.

## Outstanding work

### Code

1. **Make a stale bridge build impossible to miss.** Either build the bridges
   a profile enables before `dev:test` starts its backend, or refuse to start
   (or warn loudly) when a bridge's `dist` is older than its `src` or its
   lockfile. At minimum, the live suites (`test:agent:coordinator`,
   `test:agent:browser:isolated` and the other `ORKESTRATOR_AGENT_TEST_LIVE_*`
   specs) should fail fast rather than spend tokens on an old build.

### Qualification

- None beyond a unit test for whichever check is chosen.

## Constraints and rationale

- Building every bridge on every `dev:test` start costs time. A
  freshness check (mtime or content hash against `src`) may be enough.
- The older-bridge step in
  [agent-testing.md](../../development/agent-testing.md) deliberately swaps in
  another build. Any check must leave that override alone.

## Open questions

- Should the live suites build bridges the way the full browser tasks build
  `packages/cli/dist` first (`build:cli`), or only check freshness?

## Related

- [0054-agent-test-pi-default-model.md](0054-agent-test-pi-default-model.md)
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md)

## Replaces

- Nothing; found by the 2026-10-23 Pi coordinator run.
