# Agent-test profiles run whatever bridge build is on disk

Checked against `main` at `06297124` (2026-10-23). Finished on 2026-10-26
against `main` at `93018933`.

A `dev:test` profile launches each local bridge from its built
`bridges/<bridge>/dist/index.js` (`getBridgePath` in
`apps/backend/src/core/commands-servers.ts`). Until 2026-10-26 nothing in
`dev:test` or the live suites rebuilt that file or checked that it matched
the source (item 1 below fixes that). A live
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
  was the only guard until item 1 below.

## Outstanding work

### Code

1. ~~**Make a stale bridge build impossible to miss.**~~ Done 2026-10-26.
   Both halves of the item:
   - **Build before start.** `startDevelopment` (agent-test flavor) runs
     `prepareProfileBridgeBuilds` (`apps/desktop/scripts/dev/bridge-builds.ts`)
     right after Electron compiles and before the backend starts:
     `bunx turbo run build` for all five bridges, logged to the profile's
     `logs/bridge-build.log`. A failed build, or one that leaves a bridge with
     no `dist/index.js`, marks the profile failed and stops the start. It then
     writes `runtime/bridge-builds.json`: each bridge's Turbo `build` task hash
     (from `--dry=json`) and the SHA-256 of its `dist/index.js`.
   - **Fail fast in the live suites.** `e2e/agent-testing/bridge-builds-setup.ts`
     is the `globalSetup` of `playwright.browser.config.ts` (so also of the
     paused-interactions and Claude warm-runtime configs, which spread it) and
     of `playwright.coordinator.config.ts`. `checkProfileBridgeBuilds`
     compares the record with the checkout and throws, naming each stale
     bridge and the restart command, when a bridge's sources or `dist` changed
     since the profile started. `ORKESTRATOR_AGENT_TEST_ALLOW_STALE_BRIDGES=1`
     turns the failure into a warning. A profile with no record (started by an
     older checkout) is warned about, not failed.
   - **Evidence.** `apps/desktop/scripts/dev/bridge-builds.test.ts` (7 tests:
     plan parsing, comparison, record write and read, a failed and an empty
     build, the guard's five states, and a real `startDevelopment` agent-test
     start that runs typecheck, bundle, then the bridge build and is marked
     failed with the log path when the build fails). Disabling the build in
     `startDevelopment` makes the last test fail. Real stack on 2026-10-26
     (macOS, profile `qa-0056 --fixture`): the start logged `6 cached, 6
     total` in 7.8 s and wrote the record; `browser-gateway.spec.ts` passed
     the setup and ran (12 passed; the narrow host-picker case is registered
     flake 0224, and the signed-out Codex case needs the credential-free
     profile the isolated runner creates, not this one). After adding a file
     under `bridges/pi-bridge/src`, the same command failed in global setup
     with `pi-bridge: its sources changed since the profile started` before
     any test ran, the override ran it with a warning, and after `dev:stop`
     and `dev:test` the start rebuilt pi-bridge (`5 cached, 6 total`, 10.4 s)
     and the setup passed. Playwright with a fabricated stale record under a
     temporary `HOME` also failed in global setup.

### Qualification

- ~~A unit test for whichever check is chosen.~~ Done 2026-10-26; see
  item 1's evidence.

## Constraints and rationale

- Building every bridge on every `dev:test` start costs time. A
  freshness check (mtime or content hash against `src`) may be enough.
- The older-bridge step in
  [agent-testing.md](../../development/agent-testing.md) deliberately swaps in
  another build. Any check must leave that override alone.

## Open questions

- ~~Should the live suites build bridges the way the full browser tasks build
  `packages/cli/dist` first (`build:cli`), or only check freshness?~~
  Answered 2026-10-26: `dev:test` builds, the suites only check. See the
  first decision below.

## Assumptions and decisions

1. **Build at profile start, check in the suites.**
   - Options: (a) only an mtime or hash freshness check that warns or
     refuses; (b) build in each live suite, like `build:cli`; (c) build in
     `dev:test`, and check in the suites against what the profile started
     with.
   - Chose (c). The bridges' `dist` matters when the backend launches them,
     which is the profile, not the suite; a suite-side build cannot replace
     bridge processes a running profile already started, so the suites can
     only tell the operator to restart.
   - Pros: a fresh profile is always current with no manual step; a later
     edit is caught before any billed turn. Cons: every `dev:test` start
     spends 1–8 s on a Turbo cache restore (about 5 s more when a bridge
     changed), and a bridge that does not compile blocks the start.
2. **Turbo as the freshness oracle.**
   - Options: hand-rolled mtimes of `src` against `dist`; a hand-rolled
     content hash of each bridge's `src`, lockfile and bundled workspace
     packages; Turbo's `build` task.
   - Chose Turbo. Its task hash already covers each bridge's tracked files,
     its lockfile entries and `packages/protocol` through `^build`, a cache
     hit writes the cached `dist` back over whatever is on disk, and
     `--dry=json` gives the hash in about 0.1 s.
   - Pros: no second definition of a bridge's inputs to drift; checkout and
     rebase mtimes cause no false alarms. Cons: depends on Turbo's dry-run
     JSON shape (`tasks[].taskId`/`hash`), parsed defensively and covered by a
     test; a change to root files Turbo hashes globally marks all five stale.
3. **The record also holds the bundle hash.** A hand rebuild under a running
   profile changes `dist` while older bridge processes may still run, so it
   fails too. A rebuild from unchanged sources produces the same bundle and
   is not flagged.
4. **The record is a separate file, not a `status.json` field.**
   `parseRuntimeStatusManifest` rejects unknown fields and the published
   `orkestrator` CLI reads that manifest, so a new field would break older
   CLIs reading a newer profile. Con: one more file in `runtime/`, removed
   with the profile by `dev:reset`.
5. **Fail every agent-testing run, not only `ORKESTRATOR_AGENT_TEST_LIVE_*`
   ones, with an explicit override.** A credential-free run on an old bridge
   also proves nothing about the change. Con: an unrelated bridge edit stops
   a run until the profile restarts or the override is set.
6. **All five bridges, whatever `--agent-platforms` says.** Unchanged ones
   cost a cache restore, and a platform list does not bound which bridges a
   spec starts. Con: an edit to one bridge fails a run that uses another.
7. **Agent-test flavor only.** `mise run dev` starts the same code from
   inside a `turbo run dev`; a nested Turbo build there was not qualified,
   and the item covers `dev:test` and the live suites. `playwright.electron.config.ts`
   launches its own Electron rather than a `dev:test` profile and is not
   guarded either.
8. **The older-bridge override is untouched.** `mcp-apply-inactive.spec.ts`
   copies an older `index.js` in only while it starts one bridge, after the
   global setup has run, and restores it; the next `dev:test` start would
   restore the current build from Turbo's cache in any case.

## Related

- [0054-agent-test-pi-default-model.md](0054-agent-test-pi-default-model.md)
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md)

## Replaces

- Nothing; found by the 2026-10-23 Pi coordinator run.
