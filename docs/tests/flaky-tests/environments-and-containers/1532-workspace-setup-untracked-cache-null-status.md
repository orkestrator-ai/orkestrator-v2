# Workspace setup untracked-cache check got a null subprocess status at the deadline

- **ID:** 1532
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `workspace setup Git scan caches > enables the untracked cache inside a repository`
- **File:** `tests/unit/workspace-setup-preserve.test.ts:190`
- **Original command:** the container-state main merge aggregate,
  [0751](../aggregate-validation-runs/0751-container-state-main-merge-validation.md)
  (`mise run test`, reservations 4/1/2/1, beside component browser, Electron
  and Docker checks).
- **Failure:** null subprocess status at the five-second deadline (5,035.03 ms).
- **Isolated rerun:** `mise run test:logged -- --name merge-workspace-setup-owner -- bun test ./tests/unit/workspace-setup-preserve.test.ts --parallel=1 --only-failures`
  passed, exit 0, 14.3 s logged.
- **Hypothesis:** a real `git` subprocess slowed past the default deadline
  under host load. Not established. Created on 2026-10-31 from the 2026-10-25
  triage in todo 0030, which named this owner without a case. Next
  recurrence: record host load and the subprocess's own duration; if it is
  load, give the case an explicit budget rather than the default.

## Investigation — 2026-11-06

The harness is tiny: one `bash -c` that runs `sed` once and a stub `git`
twice, about four short processes in total. On this Linux host the whole case
takes milliseconds. Host load alone is unlikely to stretch that past five
seconds, even on the loaded macOS host where the aggregate saw load averages of
30 or more; the firewall fixtures (0192, 0632, 9837) fork more than a hundred
processes and needed 5–10× their idle time. The better-supported candidate is the Bun 1.4.4
lost-child-event defect in
todo 4260 (retired 2026-11-10; its record is `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`).
On macOS that defect leaves an exited child as a zombie that Bun never
reports. `spawnSync` would then block until Bun's test deadline kills it,
giving the recorded `status: null` at 5,035 ms. `runCommand` works around the
defect with a macOS exit watchdog and reaper, but these root fixtures call
`node:child_process.spawnSync` directly, which has no such protection. Not
proven: the defect could not be reproduced on Linux, and no `ps` sample of the
stuck child exists. On a recurrence, record whether the child is `Z
<defunct>`. If it is, moving the fixture's subprocesses to the backend's
`runCommand`, or to a shared bounded spawn helper with the same watchdog, is
the fix. Raising the budget would not be. Status left open.
