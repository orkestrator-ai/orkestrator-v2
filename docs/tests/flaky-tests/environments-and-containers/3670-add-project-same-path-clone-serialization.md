# add_project same-path clone serialization rejected the first clone

- **ID:** 3670
- **Status:** resolved
- **Observed:** 2026-11-03
- **Test:** `create_project_from_scratch > add_project serializes two clones of the same missing local path`
- **File:** `apps/backend/src/core/commands-project-creation.test.ts`

During the focused checks for security report L7/L9 (branch
`git-security-scans-a144ae01591c-r1`), this case failed in
`mise run test:logged -- --name backend-related -- bash -c "cd apps/backend && bun test ./src/core/change-tracking ./src/core/commands-agent-support.test.ts ./src/core/commands-agent-support-branch-rename.test.ts ./tests/commands-environment-fork.test.ts ./tests/commands-registry-environments-create.test.ts ./src/core/git-fsmonitor.test.ts ./src/core/public-api ./src/core/commands-files-local-scan.test.ts ./src/core/git-url-option-injection.test.ts ./src/core/commands-project-creation.test.ts ./src/core/worktree-snapshots-git.test.ts ./src/core/coordinator-worker-changes.integration.test.ts --parallel=6 --only-failures"`
(56 files, 6 isolated workers; 1,252 passed, 2 failed). It failed after
127.22 ms: the **first** `add_project` promise rejected with
`A project already uses this local path: …/shared-destination`, thrown from the
duplicate-path guard in `addExistingProject`'s clone branch
(`commands-projects.ts`, under `storage-context.ts` `withProjectCreationLock`).
The other failure in the run was the already-registered case 2394/2414.

The host load average was 40 on 16 cores at the time (about ten parallel
builds). The same file had passed in an earlier three-file run on the same
branch, and the complete owning file passed alone:
`mise run test:logged -- --name rerun-commands-project-creation -- bash -c "cd apps/backend && bun test ./src/core/commands-project-creation.test.ts"`
(exit zero, 4.3 s). Failure evidence: `/tmp/orkestrator-test-run.rgL3IA/`.

It failed the same way in a second focused run on the branch (26 files,
4 workers, 379 passed, 1 failed; `/tmp/orkestrator-test-run.kQNPdK/`, load
average 70).

## Stress comparison with main

Eight concurrent copies of the whole owning file
(`cd apps/backend && bun test ./src/core/commands-project-creation.test.ts`,
started together, load average about 71) failed this case 2 of 8 times on the
branch. Eight concurrent copies filtered to this one test
(`-t "serializes two clones of the same missing local path"`) failed 0 of 8.
With `commands-projects.ts` and this test file restored to `main` (`7b48c23fb`),
two rounds of eight concurrent whole-file copies failed this case 4 of 16
times, and the sibling
`create_project_from_scratch > serializes two requests for the same canonical path`
4 of 16 times. So the flake predates the branch.

Hypothesis, not established: the test's 50 ms `remainsPending` window lets the
second call, whose URL differs, reach the path-lock section under load in an
order the assertions do not expect. The branch's change to
`addExistingProject` (a synchronous refusal of URLs starting with `-`) does not
apply to either URL in this test. No assertion, timeout or product code was
changed for this record.

## Root cause and fix (2026-11-06)

`second` was created before the lock holder was released, but no handler was
attached to it until after `await expect(first).resolves`. Once `first`
releases the path lease, the waiting `second` runs the duplicate-path guard
and rejects; under load that can happen before the test reaches
`expect(second).rejects`. Bun then fails the running test with the unhandled
rejection, reported at the `first` assertion, which is why the message names
the *second* request's path. The URL test in the same file already guarded
against this ("observe it now so that is not unhandled").

The fix attaches that observer to `second` as soon as it is created in this
test, in `serializes two requests for the same canonical path` (case 9845) and
in `serializes two requests whose paths differ only in case`. The assertions
are unchanged in strength: a `second` that resolved would yield `undefined`
and fail the message match.

Not reproduced locally: on beelink at load average 0.8, eight concurrent copies
of the unchanged file failed 0 of 8, and two rounds with the fix failed 0 of 16.
The fix rests on the mechanism and on the matching `main` CI failure, not on a
stress result.
