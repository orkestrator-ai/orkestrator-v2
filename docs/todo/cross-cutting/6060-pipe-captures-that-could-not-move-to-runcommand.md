# Pipe captures that could not move to `runCommand`

## Task analysis

Analysed 2026-11-05 against `main` at `6e796ca32`. Task 5 added the same day against `main` at `af2e566e5`.

### Tasks

1. **Review worktree fingerprint script**: its Git reads use pipes, and a local environment runs it under Bun. Status: open.
2. **Database copy result**: the backend waits on `close` for the copy's verdict, with no deadline of its own. Status: open.
3. **Design export container helper**: a stall reports a completed write as an unknown outcome once the deadline passes. Status: open.
4. **Protocol captures**: `workspace-change-probe.ts`, `standalone-service.ts` and SSH `process-runner.ts` cannot import the backend's `runCommand`. Status: open.
5. **One-shot exchanges through `spawnCommand`**: some callers write stdin and wait on `close`, and one has no deadline. Status: open.

### 1. Review worktree fingerprint script

**Problem.** `REVIEW_WORKTREE_FINGERPRINT_SCRIPT` reads `git` output through pipes and settles on `close`. A lost completion event ([4260](4260-bun-loses-child-process-events.md)) would stall it.

**Context.** `apps/backend/src/core/review-worktree-fingerprint.ts`. It is source text run with `-e` inside the environment: `node` in a container and the managed Bun in a local worktree (`commands-registry-terminal.ts`). Only the local case runs Bun's readers. Only its first status read has a deadline, but the caller's 30 s or 120 s bound applies to the whole script, so a stall fails the probe instead of hanging it.

**Investigation.** None has been seen to stall. The script cannot import `runCommand`: it has to stay self-contained for the container. Its hash path also feeds a running hash and enforces a size limit while the child writes.

**Decisions.**

- **How to remove the pipe?**
  - **Capture into unlinked files inside the script, as `runCommand` does (recommended).**
    - Pros: removes the stall on both runtimes; no change to the probe's reason codes.
    - Cons: a second copy of the capture idea in script text; the size limit becomes a poll; hashing moves to after exit.
  - **Leave it, relying on the caller's bound.**
    - Pros: no risk to a probe the build pipeline depends on.
    - Cons: a stall reads as a failed validation guard.

### 2. Database copy result

**Problem.** `copyDatabaseInChildProcess` waits on `close` to read `sound` or `unsound`. If the event is lost, the backend's promise never settles.

**Context.** `apps/backend/src/core/storage-backups.ts`. `runCommand` does not fit because the supervisor treats stdin EOF as "the backend died" and kills the copy, and `runCommand` closes stdin at once. The supervisor's own deadline stops the copy but cannot settle the parent's wait.

**Investigation.** None has been seen to stall. The supervisor is itself Bun running `node:child_process`, with its output inherited, so it holds no capture of its own.

**Decisions.**

- **How to read the verdict?**
  - **Keep stdin as the liveness pipe and give stdout and stderr to unlinked files through `spawn`'s `stdio` (recommended).**
    - Pros: keeps the liveness contract; needs no pipe reader.
    - Cons: a second user of the capture-file code, so `openCaptureFile` would have to be exported; still depends on the `exit` event.
  - **Add a "keep stdin open" option to `runCommand`.**
    - Pros: one capture path.
    - Cons: an option with one caller, in the most used primitive.

### 3. Design export container helper

**Problem.** `runContainerHelper` captures a `docker exec` through pipes. Its deadline settles the call without `close`, so a stall cannot hang, but a write that succeeded would be reported as an unknown outcome after 30 s.

**Context.** `apps/backend/src/core/design/export-writer.ts`. The module is also imported by Node-based browser tests (`e2e/DesignCanvas.spec.ts`), where `Bun` is undefined, and its `DesignExportSpawn` seam lets tests withhold a payload from a real child.

**Investigation.** None has been seen to stall.

**Decisions.**

- **How to cover it?**
  - **Leave it until a stall is seen (recommended).**
    - Pros: already bounded; the seam and the Node path stay as they are.
    - Cons: a stall looks like a slow Docker.
  - **Inject a `runCommand` transport from the backend and keep `spawn` for Node fixtures.**
    - Pros: production stops using pipes here.
    - Cons: tests would keep exercising a transport production does not use.

### 4. Protocol captures

**Problem.** `runGit` in `workspace-change-probe.ts` and `runFile` in `standalone-service.ts` still capture through `execFile`, and they run under Bun. `runBoundedCommand` in `ssh/process-runner.ts` is another one-shot pipe capture.

**Context.** `packages/protocol/src/node/`. The bridges (`bridges/pi-bridge`, `bridges/cursor-bridge`) use the probe, and the backend's standalone updater (`host-standalone-updater.ts`) uses `runFile`. Protocol cannot import `apps/backend`. `ssh/context.ts` imports `spawn` as an injectable transport for SSH adapters; classify that importer as the transport seam for this one-shot capture, not as a live follower.

**Investigation.** None has been seen to stall. The two `execFile` sites have timeouts which only signal the child; whether a lost event then still leaves the promise waiting was not measured. SSH `runBoundedCommand` likewise only signals on its deadline (SIGTERM, then SIGKILL after one second). Only its exit/error handlers settle the promise, so a lost completion event can leave it pending after the deadline.

**Decisions.**

- **How to reach them?**
  - **Move `command-capture.ts` into `packages/protocol/src/node/` and have the backend re-export it (recommended).**
    - Pros: one capture path for the backend and the bridges.
    - Cons: `packages/protocol` changes are wide-reaching; `recurring-work-metrics` is backend-only, so its counting needs a hook.
  - **Leave them until one is seen to stall.**
    - Pros: no change to a package every bridge depends on.
    - Cons: the bridges' own pipe captures stay a separate question either way.

### 5. One-shot exchanges through `spawnCommand`

**Problem.** To-do 4260 task 5 left `spawnCommand` and its callers alone as live followers, but some callers use it for a single exchange and settle on `close`. `runContainerEvidenceScript` has no deadline, so a lost completion event would leave its promise pending.

**Context.** Found while classifying importers for 4260 task 5; this is not a full inventory of `spawnCommand`'s callers. In `apps/backend/src/core/`: `runContainerEvidenceScript` (`web-annotation-evidence-files.ts`, no deadline), `runContainerPathCheck` (`web-annotation-source-checks.ts`, deadline settles the call), `docker-copy-out.ts` (30 s default, deadline settles the call) and `waitForContainerReviewPackageWrite` (`commands-review.ts`, also used by `graph-artifacts.ts`, 60 s default, deadline settles the call). The container writes in `commands-registry-terminal.ts` settle on `exit` and read no output. `runCommand` accepts a `stdin` payload.

**Investigation.** None has been seen to stall, and none of these sites was run under a stall. The web-annotation and graph-artifact tests inject a spawn function that runs the helper script without Docker, so moving those sites means replacing that seam, for example with a fake `docker` on `PATH` as the moved sites' tests use. `docker-copy-out.ts` needs raw bytes and an `oversized` result, which `runCommandBuffer` and `maxOutputBytes` may cover but which was not tried.

**Decisions.**

- **How to cover them?**
  - **List every `spawnCommand` caller, then move those that only exchange one payload, starting with `runContainerEvidenceScript` (recommended).**
    - Pros: removes the one wait with no deadline; uses the existing capture path; separates real followers from one-shot callers.
    - Cons: each site's tests need a new seam; a write that succeeded but stalled today is at least bounded by its deadline, so the gain for those sites is smaller.
  - **Only add a deadline to `runContainerEvidenceScript`.**
    - Pros: a small change that removes the unbounded wait.
    - Cons: a stall still reports a command that succeeded as failed.

## Assumptions and decisions

### Task 4: SSH capture inventory

Added SSH `runBoundedCommand` and its injectable `ssh/context.ts` spawn seam to the open protocol task. Moving the shared primitive into protocol remains recommended: it preserves one capture implementation; the alternative of leaving the site has less migration risk but retains an unbounded settlement risk after the signal-only deadline. This repair records the outstanding work without widening task 5 into a protocol migration.

## Constraints and rationale

- Never settle a command as successful when its output may be missing, and never raise a test deadline, skip or retry to hide a stall.
- Keep `spawnCommand` and `spawnParentBoundCommand` for live followers.

## Related

- [4260 Bun loses a child's completion events](4260-bun-loses-child-process-events.md)
