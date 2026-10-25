# Project Home: narrow-viewport drawer probe raced the mobile shell (`e2e/agent-testing/browser-gateway.spec.ts`)

- **ID:** 0223
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `project Home retains background work and unread attention beneath the board`
- **Owning file:** `e2e/agent-testing/browser-gateway.spec.ts:386`
- **Original command:** `mise run test:logged -- --name browser-isolated-after -- mise run test:agent:browser:isolated --agent-platforms codex,opencode,cursor,grok`
  (one Playwright worker, disposable `qa-browser-80d1073b-b56` profile).
- **Failure:** `Test timeout of 120000ms exceeded`; the reported stack was the
  `close_local_terminal_session` invoke in `finally` (line 495). The trace
  shows the real stall: after `setViewportSize(390 × 844)` the
  `isVisible()` probe for "Close projects and environments" returned at once,
  and the following "Open tools" click waited 115 s.
- **Suite counts:** 19 passed, 12 skipped, 3 failed (this case, the move case
  from doc 02 and `cli-ui.spec.ts:169`, whose packaged CLI was not built).
- **Reruns:** passed in the next full `test:agent:browser:isolated` run
  (21 passed, 12 skipped, 1 failed) and alone on a manual profile.
- **Evidence:** `output/agent-testing/qa-browser-80d1073b-b56/browser/artifacts/browser-gateway-project-Ho-eee89-attention-beneath-the-board/`.

## Root cause

This is the same mechanism as 0209. Below 768px `AppShell` swaps to
`MobileAppShellLayout`, which mounts with its modal projects drawer open. The
spec checked `isVisible()` straight after the resize. When that ran before the
media-query re-render, it saw no drawer and skipped closing it. The drawer then
opened over the shell and blocked the "Open tools" click until the test timed
out.

## Fix

The spec waits for the phone layout's tools trigger (by CSS, which a modal
drawer cannot hide) before probing for the drawer. It closes the drawer only
if one is open. A later product change means the drawer now opens on its own
only on a phone-sized first load, so after this resize there is normally none.
The same spec file's host-picker case and `native-draft-attachments.spec.ts`
already wait before probing.

## Verification

The case passed three times in a row on a fresh `dev:test --fixture
--no-agent-credentials --agent-platforms codex,opencode,cursor,grok` profile
(5.7 s, 5.5 s, 5.5 s).
After the `AppShell` change it passed again on a fresh profile and in a full
`test:agent:browser:isolated` run.
