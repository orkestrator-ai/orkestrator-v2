# Coordinator fetch across remotes times out under aggregate load

- **ID:** 0480
- **Status:** resolved
- **Date observed:** 2026-10-18
- **Test:** `project coordinator > fetch covers every configured remote and a dirty submodule needs enhanced confirmation`
- **File:** `apps/backend/src/core/coordinator-service.test.ts`
- **Original command:** `mise run test:logged -- --name full-test -- mise run test`
  on branch `qualify-transcript-paging-live-mr-c2fa28c0ecdd` (live transcript
  paging qualification; the change touches only the web transcript views and
  an opt-in e2e spec, not the coordinator service).
- **Worker configuration:** the workspace group concurrent with the root,
  bridges and codex-protocol groups on a shared macOS arm64 host running
  several other agents' live test profiles.
- **Failure:** timed out at 5262.12 ms (bun's five-second default). No
  assertion message. The backend reported 9,016 passed, 41 skipped and 2
  failed across 480 files (414.4 s); the other failure was flake
  [0180](0180-worktree-tracked-edit-cache-hit.md). Every other workspace
  package, root/support, bridges and protocol passed.
- **Isolated rerun:**
  `mise run test:logged -- --name coordinator-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  passed, exit 0 (22.2 s logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.9ChzHs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Current assessment

A timeout under aggregate load, the same shape as
[0165](0165-coordinator-bound-discard-timeout.md) in the same file: the case
runs real Git fetches against several remotes plus a submodule inside one
five-second budget. Keep open until a recurrence shows whether it needs an
explicit timeout or a cheaper fixture. No coordinator implementation,
assertion, timeout or skip changed.

## Transcript-paging review fixes — 2026-10-18

`mise run test:logged -- --name full-tests -- mise run test` repeated both
coordinator timeouts (bound discard: 5169.70 ms; remote fetch: 5197.15 ms).
The backend reported 9,040 passed and two failed; every other workspace package,
the root/support group, bridges, and protocol check passed. The complete run
took 445.2 seconds alongside browser and live-provider validation.

The unchanged owning file then passed, exit 0, in 11.7 seconds:

```bash
mise run test:logged -- --name coordinator-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.g5ONdt/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No coordinator code, test, timeout, or assertion changed.

## Further main merge at f51c7252 — 2026-10-18

- **Original command:** the testing guide's GNU-tool PATH prefix, then `mise run test:logged -- --name refresh-main-tests -- mise run test`, merging `f51c7252` into `17c19221`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; backend used two isolated Bun workers alongside targeted browser and CLI validation on the shared host.
- **Failure:** `project coordinator > fetch covers every configured remote and a dirty submodule needs enhanced confirmation` exceeded its 5000 ms deadline at 5149.44 ms. The coordinator timeouts also produced late fixture errors after their deadlines.
- **Suite counts:** backend 9088 passed, 41 skipped and four failed across 9133 tests in 485 files (385.41 s); every other workspace package, root/support, bridges and protocol passed. Aggregate exited 1 after 445.1 s.
- **Owning-file rerun:** after the aggregate, the same GNU-tool PATH with `mise run test:logged -- --name refresh-main-owner-coordinator -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the unchanged file, exit 0, in 11.2 s. The three owning files ran sequentially.
- **Evidence:** `orkestrator-test-run.AP1Ws9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer log `orkestrator-test-run.TVK3dv/refresh-main-tests.log.gz`.
- **Assessment:** confirmed intermittent recurrence; shared-host contention remains a hypothesis. No implementation, assertion, timeout or skip changed.

## Resolution — 2026-10-20

- **Status:** resolved. Cases 0461, 0480 and 0490 are the same test and share
  this resolution.
- **Root cause:** test cost, not a fetch or submodule bug. One test did two
  unrelated things within one five-second budget. First, it built two bare
  remotes with `init --bare` and `push`, then ran two real `fetch --all`
  calls, one of them failing. Second, it built a submodule source repository,
  ran `submodule add`, and made four checkout inspections (each with
  `git submodule status` and `git submodule foreach`) plus a recursive
  discarding switch. That came to 166 Git processes and about 1.9 s alone.
  When the test was abandoned on its timeout, `afterEach` removed the fixture
  under the still-running body, which caused the late Git errors after fixture
  cleanup.
- **Fix for this case:** in addition to the shared changes below, the test is
  now two tests with the original assertions:
  `fetch covers every configured remote and reports a failing one as stale`
  (plus the new remote-tracking-ref assertion), and
  `a dirty submodule needs enhanced confirmation before a discarding switch`.
  The deadline is unchanged.
- **Shared fix (both coordinator cases, 0165 and 0461/0480/0490):**
  - Product, `apps/backend/src/core/project-git-service.ts`: `readStatus`
    looked up the six in-progress operation markers (`MERGE_HEAD`,
    `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
    `sequencer`) with six `git rev-parse --git-path` processes on every status
    read. They now resolve in one `git rev-parse --git-path … --git-path …`.
    If the output cannot be split into one line per marker (a Git directory
    whose path contains a newline), it falls back to one process per marker.
    Each status read now starts 6 processes instead of 11. The marker semantics
    are unchanged; the merge, rebase and cherry-pick assertions still cover them.
  - Fixtures, `coordinator-service.test.ts`: `beforeAll` builds the
    one-commit checkout, a bare clone of it and the submodule source repository
    once. Each test copies the checkout with `fs.cp` instead of running
    `git init`, two `git config` calls, `git add` and `git commit`. The
    fetch case copies the prebuilt bare repository for `origin` and `extra`
    instead of `git init --bare` plus `git push` (four processes). It also
    reuses the shared submodule source instead of building one (six processes).
    A new assertion checks that the first fetch creates both
    `refs/remotes/extra/main` and `refs/remotes/origin/main`. The checkout has
    no remote-tracking refs before the fetch, so this proves each remote was
    fetched.
  - Late work after cleanup: Bun abandons a timed-out body but keeps running it,
    and kills its child processes. `afterEach` then deleted the fixture under
    the still-running body, which caused the `disk I/O error`, ENOENT and
    "Unhandled error between tests" fallout. Every test body in the file is now
    recorded through a small `test` wrapper. `afterEach` waits for it (capped at
    25 s, hook timeout 30 s), closes `storage`, and only then removes the
    fixture. Forced-timeout check (`--timeout 300`): no `disk I/O`, ENOENT
    or SQLite errors appear. The reported durations of the timed-out cases
    include the wait. The remaining between-test reports are assertion fallout
    from Bun killing the body's Git processes, and appear only when a test has
    already timed out.
- **Measurement (before):** the logging `git` wrapper on `PATH` counted 379
  Git processes for the bound-discard case and 166 for the fetch case. Of
  these, 138 and 54 were `rev-parse --git-path`. Each checkout inspection also
  runs `git submodule status` and `git submodule foreach`, which are shell
  scripts costing roughly 12 times a `git status` (77 ms against 6.5 ms on
  this host).
- **Verification** (same macOS arm64 host, Bun 1.4.2, Git 2.56.0; other agents
  were also testing, load average 4–43; times are JUnit per-test seconds):
  - File alone, before: bound discard 2.44 s, fetch+submodule 1.93 s (52 pass,
    14.4 s).
  - File alone, after: 55 pass. The worst new case is the submodule case at
    1.2 s. The bound-discard parts take 0.92 s, 0.3–0.4 s and 0.97 s; the fetch
    case 0.3–0.45 s. Ten sequential runs: 10/10 exit 0.
  - 14 concurrent copies of the unchanged file reproduced the failure: bound
    discard timed out in 14/14 copies (5.15–5.21 s), with 14 "Unhandled error
    between tests" (`SQLiteError: disk I/O error`, ENOENT on
    `nested-repo/secret.txt`). Fetch+submodule took 4.05–4.17 s. At 10
    copies: bound discard 4.41–4.55 s, fetch 2.98–3.01 s.
  - 14 concurrent copies after the fix, run twice: 28/28 exit 0, with no
    between-test errors. Maximum per case: bound-discard parts 2.63 s, 0.82 s
    and 2.57 s; fetch 0.79 s; submodule 3.28 s. Five and six concurrent copies,
    twice each: 22/22 exit 0, maximum 3.42 s (submodule).
  - `tsc --noEmit -p tsconfig.json` and `-p tsconfig.test.json`, `oxlint`
    and `oxfmt --check` passed for the touched files. Other tests that
    exercise `ProjectGitService` (`git-remote-callers`,
    `commands-registry-project-home`, `commands-registry-coordinator`) passed
    with 39 tests.
- **Residual:** the submodule case is now the heaviest (about 1.2 s alone, up
  to 3.4 s at load average 43). Its four checkout inspections each run the two
  `git submodule` shell scripts, and these are the behaviour under test. A
  possible follow-up is to run `submodule foreach` in parallel with the other
  inspection reads.
