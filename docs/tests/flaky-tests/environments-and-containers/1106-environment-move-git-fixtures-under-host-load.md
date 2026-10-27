# Environment-move Git fixtures exceed the test deadline under host load

- **ID:** 1106
- **Status:** open
- **Date observed:** 2026-10-26
- **Owning file:** `apps/backend/src/core/environment-move.test.ts`
- **Tests (none registered before):**
  - `move_environment > moves every file and re-points git (rename)` and `(copy)`
  - `move_environment > move with an absent socket (never started)`
  - `move_environment > is exposed as a registry command returning the client environment`
  - `move failure boundaries > detects EXDEV and cleans a failed copy`
  - `move failure boundaries > keeps committed destination after bookkeeping failure (false)`
  - `move failure boundaries > a rejected commit rolls back the rename without losing its source`
  - `rejected path commit clears the journal and preserves subsequent edits (true)`
  - `a storage rejection after publishing the path never rolls it back`
  - `a nonzero Git exit after rename retains recovery and repairs the backlink`
  - `cleanup retries preserve a new directory at the source pathname`
  - `a paused copy refuses file writers and new workers before deleting the source`
  - `an acknowledged native turn with persisted idle prevents move before quiescing`
- **Tested revisions:** `1a1ef24f9` to `8268be981` on branch `test-temp-directory-4cd0548cf2b5-r1`, and the unchanged `main` at `ce205ad34` in a second checkout, macOS 27.0 arm64, Bun 1.4.4, checkout on an external volume. The branch changes only this file's teardown (it also settles terminal history) and its temporary-directory names.
- **Commands:** the 0247 qualification sweep (`TMPDIR=<empty private dir> mise exec -- bun run --cwd apps/backend test:workspace`, two workers), and the owner alone with `mise run test:logged -- --name rerun-environment-move -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts`, and the same `bun test` in the `main` checkout.
- **Failures:** each run failed a different subset, every one at Bun's five-second deadline (5,008 to 11,103 ms), usually alongside the registered [0248](0248-move-restart-recovery-submodule-timeout.md), [0291](0291-environment-move-submodule-aggregate-timeout.md) and [0621](0621-environment-move-nested-submodules-aggregate-timeout.md) cases. Host load average was 3 to 37 across the session, from other worktrees' suites; `fseventsd` held a full core.
- **Passing runs:** the owner alone passed 38 of 38 in 39.3 s on this branch earlier the same evening (before the teardown change); the sweep at `8268be981` failed none of these names (only the registered submodule cases and 0947). At the same moment and load, the unchanged `main` owner took 84.7 s and failed three of them, and this branch's owner took 82.9 s and failed five; the failures are not caused by the branch.
- **Evidence:** `orkestrator-test-run.mzrksI`, `orkestrator-test-run.Iusk8s` and later `rerun-environment-move` artifacts under `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/`; the sweep logs under `.../T/ork0247-qual/logs/backend.log` and `.../T/ork0247-qual2/logs/backend.log`.
- **Hypothesis:** the same family as [0695](0695-environment-move-no-tmux-timeout.md) and [0935](0935-environment-move-cursor-read-failure-timeout.md): Git-heavy fixtures under the generic five-second budget on a contended host. Not established.
- **Changes:** evidence only; no assertion, timeout or skip was changed.
- **Next step:** the explicit environment-move fixture budget tracked under 0291 would cover these too.

## 0247 review-follow-up qualification — 2026-10-27

`mise run test:logged -- --name review-environment-move -- bun test --cwd
apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures`
remained non-green: 34 passed, four deadline failures and four between-test
errors, 66.0 s (`orkestrator-test-run.ClEvNo` under the host temporary directory).
The failures were `moves every file and re-points git (copy)` (5015.19 ms),
both nested-submodule variants (5037.11 / 8815.24 ms), and `a failed submodule
re-link restores the original checkout` (5024.27 ms). Terminated Git children
and removed fixture paths also reported errors after the deadlines.

This run overlaps the required repository suite and other host work; it is
an owner-file rerun, not proof of an idle-host pass. The existing base-run and
passing-owner evidence above remains the basis for the deadline-family
classification. The review follow-up changes this file only to opt legacy
names into a day-old sweep; its new deterministic private-root sweep test
passes. No timeout, assertion, skip or move implementation was changed.
The submodule siblings remain tracked in [0621](0621-environment-move-nested-submodules-aggregate-timeout.md)
and [0291](0291-environment-move-submodule-aggregate-timeout.md).
