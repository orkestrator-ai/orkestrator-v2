# OpenCode compatibility probe deadline sees no exit code under aggregate load

- **ID:** 0166
- **Status:** resolved
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

## Resolution (2026-09-30)

The original hypothesis (a late exit event) was wrong: the fake server sets
`exitCode` synchronously in `kill()`. The real cause was a leak in the probe
itself. The 10 ms deadline could expire while the probe was still creating its
temp root (`mkdtemp` plus four `mkdir` calls, which are slow under load). The
deadline branch then ran the teardown with no server yet, removed the root, and
rejected. The abandoned probe carried on and spawned a server nothing would
ever stop, so `server.exitCode` stayed `null`. A deadline during the CLI version
read was worse: no teardown was registered yet, so the probe later created
both the root and the server. Against a real `opencode serve` this leaks a
process and a temp directory, which the deadline exists to prevent.

`probeOpenCode` now takes an abort signal. The deadline aborts it (with the
deadline error as the reason, so either branch rejects the same way) before
tearing down. The probe checks the signal before creating anything and again
just before spawning. The teardown waits for the bounded setup step to settle,
so it never runs ahead of a server that is about to be spawned.

Two regression tests pin both windows: a deadline during port allocation, and
a deadline during the CLI version read. Both failed on the previous
implementation and pass on the new one. The file passed five consecutive runs.
