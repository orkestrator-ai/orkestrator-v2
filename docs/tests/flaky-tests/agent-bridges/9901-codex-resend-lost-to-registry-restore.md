# Codex usage-limit resend lost when a replacement bridge answered before restoring its sessions

- **ID:** 9901
- **Status:** resolved
- **Date observed:** 2026-11-08
- **Test:** `automatic switching on the pinned codex > a native tab continues on the new account after a real bridge replacement`
- **File:** `apps/backend/tests/account-switch-resend-live.test.ts:84` (scenario host `apps/backend/tests/account-switch-stack-host.ts:172`)
- **Observed from:** branch `fix-ci-failures-46b27b2ba576-r1`, base `a49fd2815`.

## Failures

- CI `main` run 42529246854 (`02f55ea9b`), job "Tests (backend)"
  128879552311: 122,750.78 ms; 20,560 passed, 1 failed.
- CI pull-request run 42531615664 (#1988), job "Tests (backend)"
  128886835882: 123,446.95 ms; 20,579 passed, 1 failed.

Both: `Timed out waiting for the resend:
[{"account":"soonest","refused":true,"resendTurn":false,...}]`. The account
switched and the bridge was replaced (`replacing bridge: the active agent
account changed`), and the replacement bridge served `initialize` and then
nothing for 118 s. The other codex scenarios in the same file passed in
both runs.

## Root cause (product)

The codex bridge starts its HTTP server before `start()` restores the
persisted session registry from disk (`app-server-runtime-lifecycle.ts`,
`startOnce`), and `/global/health` answers `ok` meanwhile. In that window
`GET /session/:id/activity` answered `missing` (and `/session/:id/status`
404) for a session that was on disk but not yet loaded. The backend's
activity sweep treats `missing` as deletion
(`native-agent-launch-activity-reconciler.ts`, then
`invalidateNativeAgentSession`), so when the sweep reached the freshly
started replacement bridge before the resend did, it deleted the session's
mapping and its `dispatchedRequestIds`. The resend's guard inside the
session fence (`locked.dispatchedRequestIds?.at(-1) !== requestId` in
`native-agent-usage-limit-resend.ts`) then refused it without a warning, and
nothing retried. Outside the test this drops a codex tab's session record and
dispatch history after any bridge restart that races the sweep.

## Investigation

- Passed locally alone (46 s) and under two-core pressure once.
- Reproduced with four concurrent copies of the native-build pair pinned to
  two cores with two busy loops: codex failed 2 of 4, twice, with the CI
  message. Claude passed every time.
- Temporary tracing showed, in failing runs only: verdict `resend`, the
  dispatch never approved, and the next sweep observation with no
  `dispatchedRequestIds`. A trap on `saveNativeAgentSession` dropping
  dispatched ids fired only in the failing runs, from
  `invalidateNativeAgentSession`.

## Fix

`bridges/codex-bridge`: `start()` marks the registry `restoring`
synchronously and `startOnce` marks it `restored` once persisted sessions are
back, before the engine starts. A middleware on `/session/*` and
`/sessions/*` waits for that (bounded at 10 s, then 503, which the backend
treats as unavailable, never as deletion). The bridge now starts the engine
before the server, so the state is set before any request is handled.
`/global/health` is unaffected.

## Verification

- With the fix, the same four-way two-core reproduction passed 16 of 16
  codex runs (two rounds of four, both platforms each).
- New tests: `app-server-runtime-lifecycle.test.ts` ("reports the registry
  restored only once persisted sessions are back", with a gated store load)
  and `index-routes.test.ts` ("never answers a session missing while the
  persisted registry is still restoring"). The codex-bridge suite passed
  (`mise run test:logged -- --name codex-bridge-tests -- bun test
  bridges/codex-bridge --parallel=2 --only-failures`).

## Related

- The claude, cursor, pi and ACP bridges were not audited for the same
  listen-before-restore window.
- The live test keeps only the last 4,000 characters of the scenario's
  combined output, which on CI was mostly unrelated agent-mail lines; the
  decisive evidence needed a local reproduction.
