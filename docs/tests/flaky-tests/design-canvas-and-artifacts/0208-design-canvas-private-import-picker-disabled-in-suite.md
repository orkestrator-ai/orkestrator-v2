# Private canvas import picker: "Select file" stayed disabled late in the real-stack suite (`e2e/agent-testing/design-canvas.spec.ts`)

- **ID:** 0208
- **Status:** open
- **Date observed:** 2026-10-14
- **Test:** `e2e/agent-testing/design-canvas.spec.ts:230 › private canvases
  survive reload and can be retired to recover quota`.
- **Failure:** `expect(picker.getByRole("button", { name: "Select file", exact: true })).toBeEnabled()`
  at line 343 received `disabled`: after filling the host-path picker with the
  freshly written `private-import.orkdes` and pressing Enter, the picker never
  enabled selection.
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=<profile> mise run test:agent:browser`
  against a `dev:test --fixture --no-agent-credentials --agent-platforms
  codex,opencode,cursor,grok` profile while validating the OpenCode boundary
  cleanup branch (`opencode-bridge-a8c2ab5c85b9-r1`): 17 passed, 12 skipped,
  5 failed. This case ran 30th, after the browser-gateway, CLI and
  draft-attachment specs had exercised the same profile.
- **Isolated rerun:** the same case alone (`--grep "private canvases survive reload"`)
  on a fresh profile with the same flags passed twice (11.4 s, 11.3 s). It also
  passed on the base commit in a five-spec run.
- **Evidence:** `output/agent-testing/qa-browser-oc/browser/artifacts/design-canvas-private-canv-b923a-be-retired-to-recover-quota/`.
- **Hypothesis:** state left in the shared profile by earlier specs (host
  picker listing or canvas quota) delays or blocks the picker's path
  resolution. The branch does not touch the design canvas, the host path
  picker or this spec.

## Recurrence with a different symptom (2026-10-15)

- **Original command:** `mise run test:logged -- --name design-isolated-before -- mise run test:agent:design:isolated`
  (one Playwright worker, disposable `qa-browser-512b16ed-7a4` profile)
  while validating the host-dependency fixes for
  `docs/2026-10-14/05-real-stack-suite-host-dependencies.md`.
- **Failure:** `locator.click: Timeout 15000ms exceeded` waiting for
  `getByRole('button', { name: 'Expand project origin', exact: true })` at
  line 266, called from line 289 just after `page.reload()`. The failure
  screenshot is a blank dark page with no rendered app. The case ran second,
  straight after the 0209 failure in the same profile.
- **Suite counts:** 2 failed (this case and 0209), 0 passed.
- **Reruns:** passed in the next three runs: the design spec file alone on a
  manual profile (2 passed, 47.4 s) and two full `test:agent:browser:isolated`
  runs.
- **Evidence:** `output/agent-testing/qa-browser-512b16ed-7a4/browser/artifacts/design-canvas-private-canv-b923a-be-retired-to-recover-quota/`.
- **Hypothesis:** the renderer had not mounted after the reload within the
  action timeout. It has not recurred since 0209's spec was fixed, but the
  cause is not established.

## Ordering review (2026-10-16)

Reviewed with the backend design flakes 0193, 0215 and 0218, which were test
artefacts, not ordering bugs. The backend hint order this spec relies on is
now pinned in `core/design/sync.test.ts`: per-canvas commit order, and status
hints that never overtake their commit. This case was not rerun. Its symptoms
(Playwright action timeouts, a disabled picker, an unmounted page) are client
or profile timing, and nothing here implicates the design change feed. It
stays open; see the follow-up in
[0036-design-canvas-qualification.md](../../../todo/design-canvas/0036-design-canvas-qualification.md).

## Standalone reruns — 2026-10-22

`mise run test:logged -- --name design-isolated -- mise run test:agent:design:isolated` ran three times on fresh disposable profiles at host load averages 31–60, once with the branch's product files reverted to `b83ae534`. This case passed every time, in 40–48 s per file run. The other case in the file failed every time at the new design tab's brief, which is recorded in [0036](../../../todo/design-canvas/0036-design-canvas-qualification.md) under the opening-prompt item and is not this flake. The case was not run late in a full `test:agent:browser` run, the only setting where it has failed. It stays open. No implementation, assertion, timeout or skip changed.
