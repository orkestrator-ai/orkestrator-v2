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
  - `an incomplete copy rollback never asks recovery to adopt its partially removed destination` (added 2026-10-27)
  - `rejected path commit clears the journal and preserves subsequent edits (false)` (added 2026-10-27)
  - `source cleanup failure retains a committed copy for restart retry` (added 2026-10-27)
  - `abandons a final copy without a copied-phase record and repairs the original` (added 2026-10-27, repeat sweep)
  - `move admission waits for already admitted mutations to settle` (added 2026-10-27, acceptance verification)
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

## 0247 verification run — 2026-10-27

The acceptance verification's `mise run test` (`verify-0247-full-suite`,
619.0 s, exit 1; workspace summary `orkestrator-test-run.IpdbGA` under the
host temporary directory) failed three cases of this file that no entry named
before: `an incomplete copy rollback never asks recovery to adopt its
partially removed destination` (5008.95 ms), `rejected path commit clears the
journal and preserves subsequent edits (false)` (6351.48 ms; its `(true)`
variant was already listed) and `source cleanup failure retains a committed
copy for restart retry` (5110.94 ms), all at Bun's five-second deadline,
beside the registered submodule cases. The same run's isolated reruns of
these cases passed on the branch (`verify-branch-environment-move-extra-cases`,
6.6 s) and on `origin/main` (`verify-main-environment-move-extra-cases`,
5.8 s). A further owner rerun of just these three names on this branch
(`5702c8255` plus the then-uncommitted bridge and preview fixes of
`8e5990c5e`, none of which touch this file or `environment-move.ts`),
`mise run test:logged -- --name env-move-1106-extra -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts -t "an incomplete copy rollback never asks recovery|rejected path commit clears the journal and preserves subsequent edits|source cleanup failure retains a committed copy"`,
passed in 12.0 s at host load average 81. They are added to the list above;
no assertion, timeout or skip was changed.

## 0247 repeat sweep — 2026-10-27

The 0247 repeat sweep (`TMPDIR=<private dir> mise exec -- bun run --cwd
apps/backend test:workspace` at `0c77d9b46`, host load average 67 to 95)
failed nine cases of this file at Bun's five-second deadline: the registered
submodule cases (both nested-submodule moves, the failed re-link, restart
recovery), `Cursor read failure retains recovery until the store can follow
the destination` ([0935](0935-environment-move-cursor-read-failure-timeout.md)),
the listed `moves every file and re-points git (copy)`, `a storage rejection
after publishing the path never rolls it back` and `an incomplete copy
rollback never asks recovery to adopt its partially removed destination`, and
one new name, `abandons a final copy without a copied-phase record and
repairs the original`. That case alone,
`mise run test:logged -- --name env-move-1106-abandons -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts -t "abandons a final copy without a copied-phase record"`,
passed in 2.7 s at load average 161. Added to the list above; nothing
changed.


## Consolidated-review cleanup fixes — 2026-10-27

The teardown now bounds history settlement to two seconds and removes fixture
roots in `finally`. Its deterministic stalled-settlement regression passes;
no move assertion or timeout changed. The six-file `review-fix-integration`
run (`--parallel=2`) remained non-green under concurrent host work: 131 passed,
one skipped, 28 failed and 23 between-test errors in 386.2 s. All failures
were in this owner, beginning with the five-second test budget and followed
by hook deadlines, removed-path and SQLite errors while unfinished operations
outlived their fixtures. The other five command/preview owners then passed
together in 22.3 s.

The complete owner rerun,
`mise run test:logged -- --name review-environment-move-owner -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures`,
also failed: 13 passed, 25 failed and 23 between-test errors across 38 tests in
289.8 s. This is a retained validation failure, not a new flake classification
or proof of an idle-host pass. Evidence: `orkestrator-test-run.CUD1YR` and
`orkestrator-test-run.VXqm94` beneath the host temporary directory.

## 0247 acceptance verification: move admission — 2026-10-27

The acceptance verification of `90c9e205a` reported that
`move admission waits for already admitted mutations to settle` failed in its
direct backend sweep outside Turbo (11,995 passed, 115 skipped, 40 failed)
and in its detached `origin/main` (`863b57821`) owner run; no entry named it.
Its artifact names were not handed over, so those results are as reported.

Owner reruns of just that case on this branch at `90c9e205a`, host load
average 173 to 228 from other worktrees' suites:

- `mise run test:logged -- --name env-move-admission-0247 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts -t "move admission waits for already admitted mutations to settle"`
  failed once at Bun's five-second deadline (5,024.49 ms, load 173), followed
  by a between-test `fatal: cannot change to '.../ork-env-move-43967-GsYRHU/app'`
  from `repairWorktree` as the move outlived its removed fixture
  (`orkestrator-test-run.MTy8v5` under the host temporary directory).
- The same command passed three times in a row straight afterwards
  (`env-move-admission-0247-d1` to `-d3`: 4.8 s, 4.1 s, 4.3 s, load 216 to 228).
- With `--timeout 60000` it passed five of five (3.0 s to 6.5 s), so the case
  completes; it only crosses the five-second budget.

The test fences a mutation, checks that a move is refused, releases the
fence, then runs a full copy move with Git repair: the same Git-heavy shape
as the other names above. It is added to the list; no assertion, timeout or
skip was changed. This branch's edits to the owner are its teardown
(bounded history settlement, `finally` removal) and fixture names, not this
case or `environment-move.ts`.

