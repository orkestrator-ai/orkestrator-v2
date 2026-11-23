# Firewalld remediation subprocess timeout

- **ID:** 6601
- **Status:** resolved
- **Observed:** 2026-11-06, macOS arm64, Bun 1.4.4
- **File:** `apps/backend/src/core/containers/host-reachability.test.ts`
- **Test:** `remediation > firewalld, 2 source(s): failure at source 2 stops later rules and reload`

## Failure

The combined owner run used:

```sh
mise run test:logged -- --name peer-owner-tests -- bun test --cwd apps/backend ./src/core/agent-tools.test.ts ./src/core/agent-tools-peer-filter.test.ts ./src/core/agent-tools-peer-gate.test.ts ./src/core/containers/host-reachability.test.ts ./tests/container-network.test.ts ./tests/recovery-copies.test.ts --parallel=2 --only-failures
```

It reported 184 pass, 1 fail across six files in 32.94 s. The test timed out
at 5000 ms; its shell subprocess returned SIGTERM after 5004.98 ms at
`executeRemediation`, line 169. The runner retained evidence at
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UDSEP3`.

## Isolated rerun

```sh
mise run test:logged -- --name reachability-isolated -- bun test --cwd apps/backend ./src/core/containers/host-reachability.test.ts --parallel=1 --only-failures
```

Passed with exit 0 in 4.8 s. No remediation implementation or existing test
assertions changed between the failure and this rerun. The peer-gate change
adds only a separate network-notification test to this file.

## Investigation

The failure is in the existing bounded synchronous shell fixture, before its
rule assertions. Subprocess scheduling under concurrent work is a possible
cause, but no process trace establishes that cause. Keep the test and its
assertions unchanged; this entry records the failure and isolated pass.

## Investigation — 2026-11-06

`executeRemediation` runs the firewalld command through
`node:child_process.spawnSync("/bin/sh", …, { timeout: 5_000 })`: a `sh -c`,
the `sudo` stub, the inner `sh -c` and two `firewall-cmd` stubs, about five
processes that finish in milliseconds alone. A SIGTERM at 5,004.98 ms is
`spawnSync`'s own five-second timeout killing a child it had not seen exit.
Raw host load is a poor fit for so little work (compare the firewall
fixtures, 0192/0632/9837, which fork more than a hundred processes). The
macOS lost-exit defect in
todo 4260 (retired 2026-11-10; its record is `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`)
fits better: an exited child stays a zombie that Bun never reports, and
`spawnSync` has no watchdog. The same applies to 1532. Not reproduced on
Linux; status left open. On a recurrence, record the child's `ps` state. If
it is a zombie, give these fixtures the backend `runCommand` path, which
carries the macOS exit watchdog, rather than a longer timeout.

## Resolution (2026-11-15)

- **Root cause:** `executeRemediation` ran the shell fixture through `spawnSync` with a 5 s `timeout`. `spawnSync` blocks the event loop, so that bound, not the test budget, killed the shell (SIGTERM at 5,004.98 ms) while a starved host was still forking the fixture's processes.
- **Fix:** The `spawnSync` timeout in `apps/backend/src/core/containers/host-reachability.test.ts` is now 30 s and documented as a hang watchdog on the script's own exit; `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only.
- **Reproduced:** no — the unchanged file did not fail under the contention runner (below); the fix removes a wall-clock bound rather than a proven race.
- **Stress:** `mise run test:logged -- --name repro-be-after -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --burners 6 -- bun test --preload ../../tests/setup-node.ts ./tests/commands-environment.test.ts ./src/core/control-mcp/agent-voice-chat.test.ts ./src/core/containers/host-reachability.test.ts -t "pending rename|slow reply|cannot be written|remediation" --rerun-each=5 --parallel=1'` passed (every selected case 5 of 5) at host load about 80; the owners also passed in the wider contention runs of 2026-11-15.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
