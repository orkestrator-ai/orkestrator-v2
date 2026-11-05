# Bun loses a child's completion events, stalling pipe captures until their timeout

## Task analysis

Analysed 2026-11-04 against `main` at `a44641cb`. Task 5 re-checked and acted on 2026-11-05 against `main` at `6e796ca32`. Task 4, and task 5's held files outside `change-tracking/`, re-checked and acted on 2026-11-05 against `main` at `0194a0675`.

### Tasks

1. **Report the defect upstream**: give Bun the evidence and, ideally, a reduced case. Status: open.
2. **Find a reduced case**: reproduce the lost event without this repository's code. Status: open.
3. **Decide on a bound in `runCommand`**: stop a backend command waiting out its whole timeout for a child that has exited. Status: done (2026-11-04), through file capture and a macOS exit watchdog rather than a bound.
4. **Unblock readers parked on a superseded scan**: a read already waiting when a retarget arrives still waits for that scan. Status: done (2026-11-05). The reader is released when the attempt is aborted; a read it then makes on the same worktree still queues in admission until the old scan settles.
5. **Move the backend's other pipe captures off Bun's readers**: `node:child_process` captures outside `runCommand` can still stall. Status: done (2026-11-05) for every site not held for running work. The files held for E-0580 and S-0080 were re-checked on 2026-11-05 after both merged: nothing to move. Everything in `apps/backend/src/core/change-tracking/` stays held for E3 (#1833); re-check it when that lands. Captures that did not fit are in [6060](6060-pipe-captures-that-could-not-move-to-runcommand.md).
6. **Reap children whose exit Bun lost**: on macOS such a child stays a zombie after its command settles. Status: open.

### 1. Report the defect upstream

**Problem.** The root cause is in the runtime, so only a Bun fix removes it. Nobody has told the Bun project.

**Context.** `bun upgrade` reported 1.4.4 as the latest release on 2026-11-04, and the search made that day found no matching report. That search was one query and is not exhaustive. Filing is outward-facing, so it needs the user's approval.

**Investigation.** The evidence is in [flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#cause-2026-11-04). On Linux, the stuck socket shows `events: 40000000` in `/proc/self/fdinfo` for the epoll instance: `EPOLLONESHOT`, delivered and not re-armed. A direct `read` of that socket returns EOF, and `ss` shows the process as its only holder. On macOS the child stays `Z <defunct>`. `Bun.spawn`'s own pipes stall too, more often than `node:child_process`. No Bun canary build was tried.

**Decisions.**

- **When to file?**
  - **Check a canary build, then file with the fdinfo evidence even without a reduced case (recommended).**
    - Pros: the fdinfo line points directly at the event loop; maintainers may recognise it; does not wait on task 2, which may not succeed.
    - Cons: a report with no reduced case is harder to act on; needs the user's approval.
  - **File only with a reduced case.**
    - Pros: far more actionable.
    - Cons: about 700,000 standalone children have not reproduced it, so this could wait indefinitely.

### 2. Find a reduced case

**Problem.** The trigger is unknown. The lost event happens in the real test and in none of the standalone scripts.

**Context.** With the process held open long enough to see them, `diff-base-override.integration.test.ts` produced 50 stalled children across 150 runs on the old `runCommand`. Reproducing it there now needs a pipe capture, since `runCommand` no longer has one. In the incidents whose full timeline was inspected (three on Linux, two on macOS), the stuck child was spawned just before the test's `git clone` exited.

**Investigation.** Not sufficient by themselves, in standalone scripts: spawn options, same-tick batches, overlapping long children, destroying streams after `close`, and recursive `fs.watch`. The watcher's `persistent` and `recursive` options make no difference. What the real process has that the scripts lack: `bun test`, `bun:sqlite`, a real watched repository receiving writes, and the service's unref'd timers. `strace -f` hides the race, 81 runs with no miss.

**Decisions.**

- **How to reduce it?**
  - **Delete from the real test until the stall stops (recommended).** Measure with a probe 1 s after `exit`, holding the process open, since stalls are far more frequent than misses.
    - Pros: starts from something that reproduces; each step is a cheap 100-run comparison.
    - Cons: slower than a fresh script if the trigger turns out to be simple.
  - **Keep growing a standalone script.**
    - Pros: the result is directly reportable.
    - Cons: it has not reproduced in about 700,000 children, with no signal about what to add next.

### 3. Decide on a bound in `runCommand`

**Problem.** Any backend Git command could hit this. A 60 s command waited its whole 60 s after the child had exited, and that wait reached anything awaiting it, including a user-facing read.

**Context.** `runCommand` settled on `close` (`apps/backend/src/core/shell.ts`). Case 1537's acceptance required the shown cause to be removed, which brought this task forward.

**Investigation.** Output cannot be recovered through a stream: `read()`, `resume()` and pause-then-resume all had no effect. A bound alone could therefore only turn a stall into a failure. Avoiding the pipe avoids that: with output in a file, nothing is lost and no stream event is needed. Stress results are in [case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#load-and-stress-runs-2026-11-03-to-2026-11-04): 0 stalled children in 300 Linux runs and 175 macOS runs, where the Linux baseline had 20 in 100. How often the defect reached users was never measured.

**Decisions.**

- **What should `runCommand` do?**
  - **Capture stdout and stderr through unlinked files, and read a lost macOS exit from the zombie's status (recommended).** Implemented in `51ccfb3f2` and `4543e8b33`.
    - Pros: removes the stall instead of bounding it; loses no output and keeps the real exit code; needs no grace period that could fail a slow success.
    - Cons: two file opens per command; the temporary directory has to be usable; the output limit is noticed by polling; default capture ends at leader exit; callers needing late descendant output must opt into group waiting (see the report's decisions).
  - **Fail the command once `exit` has fired, the process group is gone and a grace period has passed.**
    - Pros: smaller change.
    - Cons: fails commands that succeeded, and a too-short grace fails a slow success on a starved host (local runs saw 3.6 s for a healthy child under load).
  - **Do nothing until Bun fixes it.**
    - Pros: no risk to the most widely used backend primitive.
    - Cons: the stall stays, with no known date for a fix, and case 1537 stays open.

### 4. Unblock readers parked on a superseded scan

**Problem.** Case 1537's superseded-scan change detaches new work from the old promise, but a same-worktree retarget still queues behind its admission lease. A `readFileList` already awaiting that scan's promise when the retarget arrives keeps waiting for it, then falls back to an ad hoc read. With task 3 done this waits only for real work, so it is a latency issue on a slow scan rather than a stall.

**Context.** `readTrackedFileList` in `apps/backend/src/core/diff-stats-service.ts`. This was not seen in the original stress runs; a deterministic real-pool service test confirmed the wait and the subsequent ad hoc read of the original identity. Re-checked on 2026-11-05 at `0194a0675`, after #1837 and #1820: the read loop, `beginLineage` and the admission pool were unchanged, so the recommended option still fit.

**Investigation.** A parked reader holds `attempt.promise` directly, so clearing `entry.inFlight` does not reach it. The scan's `abort` signal only cancels a queued admission, not a running child. Every abort of an attempt also changes the lineage, pauses or drops the entry (`beginLineage`, `stopWork`), so a released reader always finds the loop's lineage check changed.

What releasing the reader can and cannot shorten, with the production `git-docker-scan` pool (`maxPerTarget: 1`): the diff scan and the ad hoc file-list read share one admission target per worktree, and a parked reader's identity is always the old scan's worktree. So whatever the released reader reads next still queues until the old scan settles, which is the physical-release contract. What it no longer waits for is the replacement scan: before, the old lease passed to the queued replacement scan and the reader's read queued behind that too; now its read (`interactive`) is already queued and goes ahead of the replacement (`discovery`). Without an admission pool, or with a replacement on another worktree, it no longer waits for the old scan at all.

**Outcome (2026-11-05).** `awaitAttempt` races the reader's wait against the attempt's abort signal. A released reader whose request the owner still serves (a resume with the same target) joins the new lineage's scan; any other reader reads its own identity ad hoc, as before. Tests in `apps/backend/tests/diff-stats-service.test.ts`, under "readers parked on a superseded scan" plus the path-changing retarget case, fail on the old code except the no-retarget case, which passes on both.

**Decisions.**

- **How to release it?**
  - **Race the reader's wait against the attempt's abort signal (recommended).**
    - Pros: small and local; the loop already handles a changed lineage.
    - Cons: one more code path in the read loop for a case not yet observed.
  - **Pass the abort signal down to the scan's commands.**
    - Pros: also stops the superseded child and frees its admission slot.
    - Cons: plumbs a signal through every local and container status read.

### 5. Move the backend's other pipe captures off Bun's readers

**Problem.** The defect is still in Bun, so anything else that waits on a child's piped output can still stall until its own timeout.

**Context.** `runCommand` is the main path, and all 122 children of case 1537's test use it, but `node:child_process` was still imported by 43 non-test backend and protocol files. Most were followers, self-contained scripts, synchronous callers or type-only imports. `review-worktree-fingerprint.ts`, named when this task was written, is script text run inside the environment, so it could not move.

**Investigation.** None has been seen to stall; the only measurements are of `runCommand`. Long-running followers (`spawnCommand`, `spawnParentBoundCommand`) read live output, so file capture does not fit them. Moved on 2026-11-05: `disk-usage.ts` (`du`), `process-identity.ts` (`ps`), `claude-host-credentials.ts` (`security`), `ssh-agent-socket.ts`, `tailscale-serve.ts`, `preview-process-tree.ts` (`ps`), `preview-supervisor.ts` (`runDocker`), `tmux-shared.ts` (`execWithRawOutput`) and `path-safety.ts` (`writeConfinedFile`). `execWithRawOutput` accepts arbitrary commands, so it opts into `waitForDescendants` to retain late stdout/stderr from same-group helpers. It uses a 60 s default deadline (callers can override it); a deadline expiring during descendant capture reports failure. Other moved sites retain leader-exit capture.

**Held for running work, unchanged, to re-check when that work lands:**

- Everything in `apps/backend/src/core/change-tracking/`, `git-scopes.ts` included (E3, #1833, still open). `capture.ts` holds a synchronous `execFileSync` inside a `node -e` container helper, and `service-test-support.ts` and six tests import `execFileSync` directly. `git-scopes.ts` uses `runCommandBuffer`.

**Re-checked on 2026-11-05 at `0194a0675`, after E-0580 and S-0080 merged: nothing to move.**

- `apps/backend/src/core/diff-stats-service.ts` (E-0580) starts no process: its scans and reads are injected.
- `apps/backend/src/core/commands-files.ts` (E-0580) imports no `node:child_process`. Its Git commands use `runCommand`, and its container reads use `dockerExec` (`commands-container-exec.ts`), which also uses `runCommand`.
- `apps/backend/src/core/commands-containers.ts` (S-0080) imports no `node:child_process`. Its `docker` commands use `runCommand` and `dockerExec`.
- The Docker scripts (S-0080): `docker/image-manifest.ts` is the only importer under `docker/`. Its `runVersion` is a synchronous `spawnSync` in an image-build script outside the backend; it does not wait on Bun's asynchronous readers, and `runCommand` is async.

The same `git grep` at `0194a0675` gives 151 files. Two test-only importers have appeared since the tables were written and are added to the test table: `container-data-directory-reach.test.ts` and `container-lifecycle-fixtures.ts`, both synchronous `spawnSync`.

**Importer classification.** Checked on this branch at `a7db74658`, based on `main` at `af2e566e5`, with `git grep -l child_process -- apps/backend packages/protocol` over TypeScript and JavaScript files. That gives 149 files today and 154 at the merge base. Six moved sites no longer name the module, and `command-capture.ts` is new. The tables hold those 155 files, plus the held files that do not import it, which the ticket asked to list. A file with more than one site is classified by the site this task acted on, and its row says what stays.

Production code and files outside the test suites:

| File | Classification | Site and reason |
| --- | --- | --- |
| `apps/backend/src/core/claude-host-credentials.ts` | Moved | `security` Keychain read. No import left. Failed reads discard captured output. |
| `apps/backend/src/core/disk-usage.ts` | Moved | `du`. No import left. |
| `apps/backend/src/core/path-safety.ts` | Moved | `writeConfinedFile` moved. The import stays for the test-only `afterDirectoriesOpened` handshake, which needs a live read, and for `removeConfinedDirectory`, whose helper has all stdio ignored and so captures nothing. |
| `apps/backend/src/core/process-identity.ts` | Moved | Async `ps -axww` moved. The import stays for `processStartIdentity`, whose synchronous `ps` does not fit: its callers are synchronous and `runCommand` is async. |
| `apps/backend/src/core/tmux-shared.ts` | Moved | `execWithRawOutput`. No import left. Runs arbitrary commands, so it opts into `waitForDescendants` for late output, with a 60 s default deadline. |
| `apps/backend/src/core/transcript-artifacts/preview-process-tree.ts` | Moved | `ps`. No import left. |
| `apps/backend/src/core/transcript-artifacts/preview-supervisor.ts` | Moved | `runDocker` moved. The import stays for the worker child, a live follower that talks over stdin and stdout. |
| `apps/backend/src/ssh-agent-socket.ts` | Moved | Agent socket lookup command. No import left. |
| `apps/backend/src/tailscale-serve.ts` | Moved | `tailscale` commands. No import left. |
| `apps/backend/src/core/agent-accounts-login.ts` | Live follower | Interactive login: parses the prompt from output while the child runs. |
| `apps/backend/src/core/codex-host-login-refresh.ts` | Live follower | JSON-RPC over stdin and stdout with `codex app-server`; success comes from a response, and exit before it is a failure. |
| `apps/backend/src/core/commands-servers.ts` | Live follower | Type only. Long-running local bridge servers, spawned through `local-server-runtime.ts`. |
| `apps/backend/src/core/cursor-sdk-bridge.ts` | Live follower | Interactive `--login` child read while it runs. |
| `apps/backend/src/core/local-server-runtime.ts` | Live follower | Type only. Owns long-running servers started through `spawnCommand`. |
| `apps/backend/src/core/shell.ts` | Live follower | Defines `spawnCommand` and `spawnParentBoundCommand`. Unchanged; the capture primitive moved out to `command-capture.ts`. |
| `apps/backend/src/core/transcript-artifacts/media-stream-container.ts` | Live follower | Type only. Starts the container media reader through `spawnCommand` for streaming. |
| `apps/backend/src/core/transcript-artifacts/media-stream.ts` | Live follower | Type only. Streams a media reader's output as it arrives. |
| `apps/backend/src/preview-relay-supervisor.ts` | Live follower | Long-running `docker exec` relay carrying framed traffic in both directions. |
| `apps/backend/src/core/change-tracking/ (every other file)` | Held | E3. Importers in that folder have their own rows. |
| `apps/backend/src/core/change-tracking/capture.ts` | Held | E3. Synchronous `execFileSync` inside a `node -e` container helper. |
| `apps/backend/src/core/change-tracking/git-scopes.ts` | Held | E3 (#1833). No `node:child_process` import; uses `runCommandBuffer`. E-0580 has merged. |
| `apps/backend/src/core/change-tracking/service-test-support.ts` | Held | E3. Test support using synchronous `execFileSync`. |
| `apps/backend/src/core/commands-containers.ts` | Nothing to move | Re-checked 2026-11-05 after S-0080 merged. No `node:child_process` import; uses `runCommand` and `dockerExec`. |
| `apps/backend/src/core/commands-files.ts` | Nothing to move | Re-checked 2026-11-05 after E-0580 merged. No `node:child_process` import; uses `runCommand` and `dockerExec`. |
| `apps/backend/src/core/diff-stats-service.ts` | Nothing to move | Re-checked 2026-11-05 after E-0580 merged. Starts no process; scans and reads are injected. |
| `docker/image-manifest.ts` | Not fitting | Re-checked 2026-11-05 after S-0080 merged; the only importer under `docker/`. Synchronous `spawnSync` of `--version` in an image-build script outside the backend; `runCommand` is async. |
| `apps/backend/src/core/agent-credential-files.ts` | Not fitting | No import: a comment names the module. |
| `apps/backend/src/core/command-capture.ts` | Not fitting | No import: a comment names the module. This is `runCommand`'s new home, and it uses `Bun.spawn` with file capture. |
| `apps/backend/src/core/design/export-writer.ts` | Not fitting | Also imported by Node-based browser tests, where `Bun` is undefined, and its spawn seam lets tests withhold a payload. 6060 task 3. |
| `apps/backend/src/core/fix-path.ts` | Not fitting | Synchronous `execFileSync` of the login shell in a synchronous startup path; `runCommand` is async. |
| `apps/backend/src/core/process-tree.ts` | Not fitting | Type only. Signals a child it is given and captures nothing. |
| `apps/backend/src/core/public-api/exec-worker.ts` | Not fitting | Self-contained script text run inside the environment, so it cannot import `runCommand`. It supervises a detached command and follows its output. |
| `apps/backend/src/core/review-validation-worker.ts` | Not fitting | Self-contained script text run inside the environment, so it cannot import `runCommand`. It supervises project commands live and makes synchronous `git` reads. |
| `apps/backend/src/core/review-worktree-fingerprint.ts` | Not fitting | Self-contained script text run inside the environment, so it cannot import `runCommand`. [6060](6060-pipe-captures-that-could-not-move-to-runcommand.md) task 1. |
| `apps/backend/src/core/storage-backups.ts` | Not fitting | The database copy needs stdin held open as its liveness pipe, and `runCommand` closes stdin at once. 6060 task 2. |
| `apps/backend/src/core/transcript-artifacts/fixtures/fake-preview-worker.ts` | Not fitting | Test fixture. Its child has stdio ignored and captures nothing. |
| `apps/backend/src/core/transcript-artifacts/preview-worker-prepare.ts` | Not fitting | `stageContext` runs with stdio ignored, so there is no capture to move. |
| `apps/backend/src/core/validation-failure-classifier.ts` | Not fitting | Function source serialised and run inside the environment, with `require` passed in. Its child calls are synchronous. |
| `apps/backend/src/core/web-annotation-evidence-files.ts` | Not fitting | Type only. The child comes from `spawnCommand` through an injected `SpawnPipe`, which this ticket leaves alone. It is a one-shot exchange, not a follower. 6060 task 5. |
| `apps/backend/src/core/web-annotation-source-checks.ts` | Not fitting | Type only. Same `spawnCommand` seam as the evidence script; this one has its own deadline. 6060 task 5. |
| `apps/backend/src/preview-browser-harness.ts` | Not fitting | Test-only entrypoint: synchronous certificate setup plus long-running dev servers. |
| `apps/backend/src/preview-test-pki.ts` | Not fitting | Test-only: synchronous `openssl` calls. |
| `packages/protocol/src/node/claude-linux-sandbox.ts` | Not fitting | Protocol cannot import the backend, and this probe is synchronous (`spawnSync`). |
| `packages/protocol/src/node/host-test-scheduler.ts` | Not fitting | Protocol cannot import the backend, and this `ps` is a synchronous call in the scheduler factory. |
| `packages/protocol/src/node/ssh/context.ts` | Not fitting | Protocol cannot import the backend. The injectable spawn seam is used by `process-runner.ts` (one-shot, 6060 task 4) and `tunnel-starter.ts`. |
| `packages/protocol/src/node/standalone-service.ts` | Not fitting | Protocol cannot import the backend. `runFile` stays on `execFile`. 6060 task 4. |
| `packages/protocol/src/node/workspace-change-probe.ts` | Not fitting | Protocol cannot import the backend. `runGit` stays on `execFile` and `spawn`. 6060 task 4. |

Test files and helpers under `apps/backend/tests/`. None moved. The task covers the backend's captures, and these are the tests' own fixtures. Whether one could stall on the same defect was not measured; a stall would show as a test timeout and belongs in the [flake register](../../tests/flaky-tests/0000-index.md).

| File | Classification | Reason |
| --- | --- | --- |
| `apps/backend/src/core/agent-accounts-containers.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/agent-accounts-login.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/agent-accounts.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/agent-human-prompt-monitor.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/agent-skills.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/backend-runtime.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/build-pipeline-service-recovery.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/change-tracking/capture-container.test.ts` | Held | E3. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/change-tracking/capture-stat-reuse.test.ts` | Held | E3. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/change-tracking/capture.test.ts` | Held | E3. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/change-tracking/diff-bodies-lookup.test.ts` | Held | E3. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/change-tracking/manifest-cache.test.ts` | Held | E3. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/change-tracking/object-store-write-path.test.ts` | Held | E3. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/claude-state-signal.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/codex-host-login-refresh.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/command-failed-error-print.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/commands-agent-support-branch-rename.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/commands-file-copy.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/commands-secret-sweep.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/commands-state-sync.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/container-host-reachability.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/container-log-bounds.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/container-project-seed-files.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/container-scripts.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/container-worktree-signal-install.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/coordinator-mail-attachments-docker.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/cursor-sdk-login.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/design/browser-profiles.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/design/export-container.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/design/export-writer.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/design/exports.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/design/renderer.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/file-write-precondition.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/git-diff-summary.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/github-cli-setup.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/graph-artifacts.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/graph-run-rewind.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/host-model-catalog-refresh.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/index.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/local-server-runtime.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/native-agent-goal-check.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/opencode-command-changes.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/opencode-credential-plugin.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/opencode-host-start.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/pi-model-catalog-seeding.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/preview-docker.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/preview-listener-ownership.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/preview-local-discovery.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/preview-managed-roots.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/src/core/process-identity.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/process-priority.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/public-api/exec-worker.test.ts` | Not fitting | Test code: the name appears in a fake `require`, so no real child starts. |
| `apps/backend/src/core/review-validation-service.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/review-validation-worker.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/review-worktree-fingerprint.test.ts` | Not fitting | Test code: the name appears in a Git hook fixture's source text. |
| `apps/backend/src/core/session-title-runners.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/shell-process-state.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/shell.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/storage-backups.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/tmux-poll-snapshot.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/tmux-transcript-reader.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/transcript-artifacts/media-stream.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/transcript-artifacts/preview-container.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/transcript-artifacts/preview-escape.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/transcript-artifacts/preview-modules.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/transcript-artifacts/preview-print.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/transcript-artifacts/preview-process-tree.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/transcript-artifacts/preview-runaway.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/transcript-artifacts/runtime-scratch.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/transcript-artifacts/runtime.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/core/validation-failure-classifier.test.ts` | Not fitting | Test code: the name appears in fixture source text that is classified, not run. |
| `apps/backend/src/core/web-annotation-evidence-commands.test.ts` | Not fitting | Test code: the name appears inside a fake `docker` shell script. |
| `apps/backend/src/core/web-annotation-evidence-files.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/core/web-annotation-source-checks.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/main-logging.integration.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/src/preview-relay-supervisor.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/preview-tunnel-server.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/preview-vite.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/tailscale-serve-metadata.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/src/uncaught-exception.integration.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/account-switch-stack-host.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/bounded-console.integration.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/claude-credential-injection.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/claude-state-signal-integration.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/codex-mcp-parity-live.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/codex-subagent-stack.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/command-fixtures.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/commands-environment-image-download.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/commands-environment-readiness.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/commands-integration.test.ts` | Not fitting | Test code: the name appears in a fake bridge entrypoint's source text. |
| `apps/backend/tests/commands-io-coverage.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/tests/commands-servers-logging.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/container-live-workspace.ts` | Not fitting | Test helper: the name appears in source text run with `bun -e`. |
| `apps/backend/tests/container-data-directory-reach.test.ts` | Not fitting | Added 2026-11-05. Test code, not a backend capture: synchronous `spawnSync` fixture call, and `runCommand` is async. |
| `apps/backend/tests/container-lifecycle-fixtures.ts` | Not fitting | Added 2026-11-05. Test helper: synchronous `spawnSync` of `tar`, and `runCommand` is async. |
| `apps/backend/tests/container-network.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/container-readiness.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/container-replacement-inputs.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/container-replacement.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/cursor-sdk-bridge.test.ts` | Not fitting | Type only. The test uses a fake or injected child. |
| `apps/backend/tests/docker-image.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/grok-mcp-parity-live.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/opencode-mcp-reload-live.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/process-tree.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/project-git-mirror-create.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/project-git-mirror-docker.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/project-git-mirror.integration.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/standalone.test.ts` | Not fitting | Test code: the name appears in a fake server's source text. |
| `apps/backend/tests/tmux-commands.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/tmux-hook-hold-live.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/tmux-hook-hold-transport.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/tmux-hook-hold.test.ts` | Not fitting | Test code, not a backend capture: starts its own child as a fixture or as the process under test. |
| `apps/backend/tests/tmux-poll-failed-turn.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `apps/backend/tests/tmux-session.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `packages/protocol/src/node/command-failure-reason.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |
| `packages/protocol/src/node/workspace-change-probe.test.ts` | Not fitting | Test code, not a backend capture: synchronous fixture call, and `runCommand` is async. |

**Decisions.**

- **How to cover them?**
  - **Move one-shot captures to `runCommand` where it fits, leaving live followers alone (recommended).**
    - Pros: one tested capture path; no new primitive.
    - Cons: each site has its own timeout and signal handling to preserve.
  - **Leave them until one is seen to stall.**
    - Pros: no risk to working code.
    - Cons: a stall there looks like a slow command, so it may not be noticed.

### 6. Reap children whose exit Bun lost

**Problem.** On macOS, a child whose exit Bun lost stays a zombie after `runCommand` settles it, because nothing calls `waitpid` for it.

**Context.** This was 8 children in about 21,000 under heavy CPU load (175 runs of 122 children). Zombies hold a process-table entry and no memory to speak of, and they go when the backend exits. Whether Bun ever reaps them later was not measured.

**Investigation.** Node and Bun expose no `waitpid`, and the watchdog reads the status with `ps` instead. `bun:ffi` could call it, but it could race Bun's own reaper for the same PID.

**Decisions.**

- **What to do about them?**
  - **Count them first, and act only if a long-lived backend accumulates enough to matter (recommended).**
    - Pros: no risk until there is evidence of harm.
    - Cons: the count is not recorded anywhere yet.
  - **Call `waitpid` through `bun:ffi`.**
    - Pros: removes the zombie.
    - Cons: races Bun's reaper and adds a native call to the most used primitive.

## Assumptions and decisions

### Tasks 3 and 4: preserve physical admission during the case 1537 repair

Chose to document and test the same-worktree admission wait and the already-parked reader instead of releasing a running scan's lease on abort. A real `WorkAdmissionPool` test verifies that a comparison-ref-only retarget stays queued until the old work settles; a path-changing retarget proceeds. Another verifies that a parked reader waits, then returns an ad hoc result for its original identity. Releasing on abort would allow overlapping work without proof that the process stopped, violating the pool's physical-release contract. Early reader release was then left to task 4; see the next entry.

### Task 4: release the reader on abort, keep the lease

Chose the recommended option, racing the parked reader's wait against the attempt's abort signal (`awaitAttempt`), over passing the abort signal down to the scan's commands. The re-check showed the limit of either option under the production pool: the follow-up read is on the old scan's worktree, so it queues until the old scan settles. Releasing the reader still removes its wait for the replacement scan and keeps the contract. Passing the signal down would end the old wait sooner, but it plumbs a signal through every local and container status read, including `change-tracking/` (held for E3), and the scan runs as a physical pass that other requesters can share, so one requester's abort must not kill it. A test shows the old scan keeping its lease, nothing else running on the worktree, and the reader's read going ahead of the replacement scan.

### Task 4: a released reader joins the new lineage when its identity is unchanged

When the entry is still active and its current target is exactly the request's identity (a pause and resume of the same target), the reader adopts the new lineage and joins its scan instead of making an ad hoc read. This returns the owner's result and view stamp and avoids a duplicate scan. Any other retarget keeps the ad hoc read of the request's own identity, because the request names its comparison ref and worktree and must not be answered for another.

### Task 3: file capture rather than a bound

Chose file capture because a bound could only fail a command that had succeeded, and the ticket for case 1537 required the cause removed rather than turned into a different failure. The macOS watchdog is limited to macOS because the lost exit was only observed there: none of 141 Linux stalls lost it. Tasks 5 and 6 were added for what this leaves.

### Task 5: `runCommand` moves to its own module

Chose to move the capture primitive to `command-capture.ts`, with `shell.ts` re-exporting it, because `shell.ts` imports `path-safety.ts`, so `path-safety.ts` importing `shell.ts` would be a runtime cycle, which lint refuses. Every other importer stays on `shell.ts`.

### Task 5: two additions to `runCommand`, and no new primitive

Added `maxOutputBytes`, because each moved site had its own `maxBuffer` that a caller-side check after exit could not enforce while the child ran. Added `stderr` and `stdoutBytes` to `CommandFailedError`, because sites that report a status (`execWithRawOutput`, `runDocker`, `writeConfinedFile`, the Tailscale errors) need the streams apart and `message` merges them. `stdoutBytes` stays empty for a command with redacted values, since redaction works on text.

### Task 5: what changes at a timeout

Took `runCommand`'s single timeout behaviour rather than adding a kill-signal option: SIGTERM to the command's private group, then SIGKILL 100 ms later. `execFile` sites gain the SIGKILL. `execWithRawOutput` and `runDocker` used an immediate SIGKILL to the child alone, so they settle up to 100 ms later and also stop its descendants. Their results are unchanged, and tests cover a child that ignores SIGTERM.

### Task 5: output limits where a site had none

`execWithRawOutput` had no limit, and a container's first transcript tail reads from offset 0, so it passes 1 GiB rather than `runCommand`'s 50 MiB. Past that limit it rejects, because the tail reader ignores the status and would otherwise skip bytes. `runDocker` keeps returning the first 64 KiB of stdout as a success, as it did; a client past 50 MiB on a stream now gets no exit code.

### Task 5: Keychain output

`security`'s stdout now lands in an unlinked, owner-only file for the command's lifetime, rather than a pipe. Accepted because `agent-accounts-promotion.ts` already reads Keychain secrets through `runCommand`, and the file has no name on disk. Its blocks are freed on close, not overwritten, so it does rest on disk encryption for that window.

### Task 5: `writeConfinedFile`'s test hook keeps a pipe

`afterDirectoriesOpened` has to act between the helper pinning its directories and receiving the payload, which needs a live read, so that path stays on `spawn`. Only tests set it. They exercise the same helper script but not `runCommand`'s delivery; `path-safety.test.ts` covers that path separately.

### Task 5: where the importer table lives

Put the table in task 5's subsection rather than a new file, because the ticket forbids new report files under `docs/` and a later worker re-checking the held files needs it next to their list. It covers test files as well as production code because the acceptance criterion says every importing file.

### Task 5: one-shot exchanges through `spawnCommand` stay put

`web-annotation-evidence-files.ts` and `web-annotation-source-checks.ts` import only a type, and their child comes from `spawnCommand`. They are one-shot exchanges rather than followers, but the ticket leaves `spawnCommand` and its callers alone, so they are classified as not fitting and recorded in [6060](6060-pipe-captures-that-could-not-move-to-runcommand.md) task 5 with the other callers found while classifying. Moving them here would have changed code the ticket says to leave unchanged.

### Task 5 review repair: descendant completion and credential failures

Tmux capture now waits for its private process group and defaults to a 60 s deadline. Leader-only capture would finish earlier for background helpers but could silently omit output, so complete capture is preferred; group waiting can also wait for helpers that redirected their output. Explicit caller deadlines still apply, and explicit zero still disables the deadline. Login-shell exclude setup opts out of group waiting: a profile may start a redirected service that must survive setup. A caller-level test runs the real setup and verifies both the exclude file and helper survival.

Failed Keychain reads now discard all captured output and use a fixed diagnostic while retaining failure classification. Returning partial output would aid diagnosis but could disclose credential material in error messages. Tests cover timeout, overflow and nonzero exit.

### Task 3: completion after daemon regression review

Leader exit now ends default capture; explicit `waitForDescendants` retains late
output and deadline-bound group waiting. Always waiting for the group preserved
late output but blocked same-group fsmonitor daemons, so it was rejected. Tests
cover helper survival, automatic daemon startup through project-home status,
capture filesystem failures, and bounded unknown process inspection.

### Task 5: login-shell completion and timeout-test determinism

Exclude setup uses leader-exit completion through an explicit per-call option.
Keeping group waiting everywhere retains output but also blocks on redirected
profile services; opting out only for setup preserves transcript completeness
and profile helper lifetime. A controlled fixture profile is sourced by a real
login shell so this test does not read the developer's shell profile.

Deadline-only assertions no longer require shell startup or output within 100 ms;
nonzero-exit cases still verify byte and stream preservation. The real-process
command-capture suite uses the integration naming convention, placing it in the
slow tier without changing the shared tier runner. Docker overflow tests disable
the command deadline and cover both successful exit and a still-running writer,
so a timeout cannot masquerade as overflow handling.

### Task 5: held files re-checked, nothing moved

E-0580 and S-0080 merged, so their held files were re-checked against the task 5 rules on 2026-11-05. None holds a one-shot asynchronous capture outside `runCommand`, so none moved and no `runCommand` option was added. `docker/image-manifest.ts` stays on `spawnSync`: a synchronous call does not wait on the asynchronous readers that lose the event. `change-tracking/` was not opened for changes, because E3 (#1833) is still open.

## Constraints and rationale

- Never raise a test deadline, skip or retry to hide this; see the [flake rules](../../tests/flaky-tests/0000-index.md).
- Never settle a command as successful when its output may be missing.
- Flake case 1537 and task 2 of [CI shard report 0010](../../reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md) were closed by task 3. Reopen the case if the test misses its deadline again.

## Needs verification

- Whether the lost event happens on x86-64 Linux. All Linux evidence is aarch64 in a container; CI's misses suggest it does, but no CI run has reported a step.
- How often it reaches users through the remaining pipe captures ([6060](6060-pipe-captures-that-could-not-move-to-runcommand.md)).
- Whether a Bun canary build still has it.

## Related

- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)
- [CI shard report 0010](../../reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md)
- [0030 test suite and CI health](0030-test-suite-and-ci-health.md)
- [6060 pipe captures that could not move to `runCommand`](6060-pipe-captures-that-could-not-move-to-runcommand.md)

## Replaces

Nothing; new observation.
