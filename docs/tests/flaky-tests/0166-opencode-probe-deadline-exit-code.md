# OpenCode compatibility probe deadline sees no exit code under aggregate load

- **ID:** 0166
- **Status:** open
- **Date observed:** 2026-09-26
- **Test:** `runOpenCodeLiveCompatibility > kills the server when the overall deadline expires`
- **File:** `scripts/opencode-live-compatibility-probe.test.ts`
- **Original command:** `mise run test` on branch
  `implement-improvements-ecf7c41c13cd-r1`. Neither the probe script nor
  `apps/web/src/lib/opencode-client.ts` is changed by this branch.
- **Worker configuration:** root group (3 worker slots) concurrent with the
  workspace, bridges and codex-protocol groups.
- **Failure:** at `scripts/opencode-live-compatibility-probe.test.ts:378`,
  `expect(server.exitCode).toBe(0)` received `null` 166.86 ms into the test:
  the probe rejected on its 10 ms deadline, but the killed fixture server had not
  reported its exit yet.
- **Isolated rerun:**
  `mise run test:logged -- --name oc-probe-N -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures`
  passed three times in a row.

## Current assessment

The assertion reads `exitCode` synchronously after the probe rejects. Under
load the child's exit event can arrive after that read. Likely fix: await the
fixture process's exit (bounded) before asserting its code. Keep open until
fixed or seen again.
