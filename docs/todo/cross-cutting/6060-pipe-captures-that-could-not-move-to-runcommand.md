# Pipe captures that could not move to `runCommand`

## Task analysis

Analysed 2026-11-05 against `main` at `6e796ca32`.

### Tasks

1. **Review worktree fingerprint script**: its Git reads use pipes, and a local environment runs it under Bun. Status: open.
2. **Database copy result**: the backend waits on `close` for the copy's verdict, with no deadline of its own. Status: open.
3. **Design export container helper**: a stall reports a completed write as an unknown outcome once the deadline passes. Status: open.
4. **Protocol captures**: `workspace-change-probe.ts` and `standalone-service.ts` cannot import the backend's `runCommand`. Status: open.

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

**Problem.** `runGit` in `workspace-change-probe.ts` and `runFile` in `standalone-service.ts` still capture through `execFile`, and they run under Bun.

**Context.** `packages/protocol/src/node/`. The bridges (`bridges/pi-bridge`, `bridges/cursor-bridge`) use the probe, and the backend's standalone updater (`host-standalone-updater.ts`) uses `runFile`. Protocol cannot import `apps/backend`.

**Investigation.** None has been seen to stall. Both have `execFile`'s timeout, which only signals the child; whether a lost event then still leaves the promise waiting was not measured.

**Decisions.**

- **How to reach them?**
  - **Move `command-capture.ts` into `packages/protocol/src/node/` and have the backend re-export it (recommended).**
    - Pros: one capture path for the backend and the bridges.
    - Cons: `packages/protocol` changes are wide-reaching; `recurring-work-metrics` is backend-only, so its counting needs a hook.
  - **Leave them until one is seen to stall.**
    - Pros: no change to a package every bridge depends on.
    - Cons: the bridges' own pipe captures stay a separate question either way.

## Constraints and rationale

- Never settle a command as successful when its output may be missing, and never raise a test deadline, skip or retry to hide a stall.
- Keep `spawnCommand` and `spawnParentBoundCommand` for live followers.

## Related

- [4260 Bun loses a child's completion events](4260-bun-loses-child-process-events.md)
