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
