# Bun loses a child's completion events, stalling pipe captures until their timeout

## Task analysis

Analysed 2026-11-04 against `main` at `a44641cb`. Task 5 re-checked and acted on 2026-11-05 against `main` at `6e796ca32`. Task 4, and task 5's held files outside `change-tracking/`, re-checked and acted on 2026-11-05 against `main` at `0194a0675`. The captures that had not fitted task 5 re-checked and acted on 2026-11-05 against `main` at `41f9eb638`. Tasks 2 and 6 acted on, task 1 drafted, and the `change-tracking/` hold re-checked on 2026-11-06 against `main` at `e6c3da899`.

### Tasks

1. **Report the defect upstream**: give Bun the evidence and, ideally, a reduced case. Status: open. The report text is drafted in [Draft report](#draft-report), without a reduced case because task 2 found none; checking a canary build and filing are the user's call.
2. **Find a reduced case**: reproduce the lost event without this repository's code. Status: done (2026-11-06) without a reduced case. About 415,000 more standalone children, and a strict probe of the real test, lost nothing; the attempts are in [Outcome (2026-11-06)](#outcome-2026-11-06), and the next attempt moved to [to-do 6900](6900-reproduce-lost-child-event-on-pipe-capture.md).
3. **Decide on a bound in `runCommand`**: stop a backend command waiting out its whole timeout for a child that has exited. Status: done (2026-11-04), through file capture and a macOS exit watchdog rather than a bound.
4. **Unblock readers parked on a superseded scan**: a read already waiting when a retarget arrives still waits for that scan. Status: done (2026-11-05). The reader is released when the attempt is aborted; a read it then makes on the same worktree still queues in admission until the old scan settles.
5. **Move the backend's other pipe captures off Bun's readers**: `node:child_process` captures outside `runCommand` can still stall. Status: done (2026-11-05; the last held folder re-checked 2026-11-06). The files held for E-0580 and S-0080 were re-checked on 2026-11-05 after both merged: nothing to move. `apps/backend/src/core/change-tracking/` was re-checked on 2026-11-06 after E3 (#1833) merged: nothing to move. The one-shot captures that did not fit at first were moved or decided on 2026-11-05; see [Task 5: the captures that did not fit at first](#task-5-the-captures-that-did-not-fit-at-first).
6. **Reap children whose exit Bun lost**: on macOS such a child stays a zombie after its command settles. Status: done (2026-11-06). A bounded reaper calls `waitpid` for that one child once it is this process's zombie and Bun still has not reported it.

### 1. Report the defect upstream

**Problem.** The root cause is in the runtime, so only a Bun fix removes it. Nobody has told the Bun project.

**Context.** `bun upgrade` reported 1.4.4 as the latest release on 2026-11-04, and the search made that day found no matching report. That search was one query and is not exhaustive. Filing is outward-facing, so it needs the user's approval. Nothing was filed or searched upstream on 2026-11-06.

**Investigation.** The evidence is in [flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#cause-2026-11-04). On Linux, the stuck socket shows `events: 40000000` in `/proc/self/fdinfo` for the epoll instance: `EPOLLONESHOT`, delivered and not re-armed. A direct `read` of that socket returns EOF, and `ss` shows the process as its only holder. On macOS the child stays `Z <defunct>`. `Bun.spawn`'s own pipes stall too, more often than `node:child_process`. No Bun canary build was tried. Task 2 found no reduced case (2026-11-06), and showed that a single look at a zombie overcounts lost exits, so the draft below counts only the traced 10 s cases for macOS.

#### Draft report

For the user to file at <https://github.com/oven-sh/bun/issues> after checking a canary build (`bun upgrade --canary`) and searching for an existing report. Fill in the canary result first. Everything below was observed in this repository; nothing is filed.

> **Title:** Child process completion events occasionally never delivered: pipe EOF on Linux (EPOLLONESHOT left unarmed), exit on macOS (child left a zombie)
>
> **Bun version:** 1.4.4 (also: canary `<version>`, `<reproduces / does not>`)
> **Platforms:** Linux aarch64 (`oven/bun:1.4.4` container, 4 CPUs) and macOS arm64 (macOS 27, 18 cores); Linux x86-64 likely (CI misses), not traced.
>
> **What happens.** A short child (`git status`, `git rev-parse`; exit code 0 a few milliseconds after spawn) finishes, but one of its completion events never reaches JavaScript. The process stays responsive (timers fire, other children complete), so it waits until the caller's own timeout.
>
> - **Linux, pipe EOF.** Spawned through `node:child_process` with piped stdout/stderr, `exit` fires and stderr ends, but stdout never emits `end`/`close`. The stream reports `flowing`, not ended, not destroyed, and `read()`/`resume()` do not recover it. `/proc/self/fdinfo/<epoll fd>` lists the socket as `tfd: 29 events: 40000000`: `EPOLLONESHOT` with no interest bits, so the readiness event was delivered and the fd never re-armed. A direct `read(2)` of that fd returns 0 (EOF), and `ss -xpn` shows this process as its only holder. Across 141 such stalls the `exit` event always arrived. An eager `Bun.spawn` pipe stalled more often than `node:child_process` (121 stalled children versus 20, in 150 and 100 runs of the same test).
> - **macOS, exit.** The same stall, and in two of three traced cases the `exit` event never arrived either: `ps` showed the child as `Z <defunct>` for the whole 10 s until the caller's timeout, so nothing called `waitpid` for it.
>
> **How often.** In one integration test that runs about 122 short `git` children per run, alongside a recursive `fs.watch` on the repository being changed, `bun:sqlite` and a `git clone`: 20 stalled children in 100 runs on Linux, and test misses in 4 of 40 CI runs. `strace -f` hides it (81 runs, no miss).
>
> **No reduced case.** About 1.1 million children in standalone scripts did not reproduce it: plain and batched spawn loops, overlapping long and short children, the integration test's command pattern on a watched repository with nested `bun` children, `git clone` and `bun:sqlite`, with file, `Bun.spawn` and `node:child_process` capture. On macOS a probe that reads zombie state with `waitid(WNOWAIT)`, so it starts no process and reaps nothing, saw only exits delivered up to 152 ms after the child became a zombie, never a loss. The closest script is attached.
>
> **Workaround in use.** Output captured through unlinked files instead of pipes (no stream events needed), and on macOS the exit read from the zombie's wait status with `ps -o stat=,xstat=` once a command has run 1 s, then the child reaped with `waitpid(pid, WNOHANG)` through `bun:ffi`.
>
> **Expected.** Every child's `exit`, and EOF on each of its pipes, is delivered once the kernel reports them.

Attach `lost-child-event-probe.ts` from [Outcome (2026-11-06)](#outcome-2026-11-06) as the attempted reduction, saying that it does not reproduce.

**Decisions.**

- **When to file?**
  - **Check a canary build, then file the draft with the fdinfo evidence even without a reduced case (recommended).**
    - Pros: the fdinfo line points directly at the event loop; maintainers may recognise it; task 2 did not produce a reduced case, and [to-do 6900](6900-reproduce-lost-child-event-on-pipe-capture.md) may not either.
    - Cons: a report with no reduced case is harder to act on; needs the user's approval.
  - **File only with a reduced case.**
    - Pros: far more actionable.
    - Cons: about 1.1 million standalone children have not reproduced it, so this could wait indefinitely.

### 2. Find a reduced case

**Problem.** The trigger is unknown. The lost event happens in the real test and in none of the standalone scripts.

**Context.** With the process held open long enough to see them, `diff-base-override.integration.test.ts` produced 50 stalled children across 150 runs on the old `runCommand`. Reproducing it there now needs a pipe capture, since `runCommand` no longer has one. In the incidents whose full timeline was inspected (three on Linux, two on macOS), the stuck child was spawned just before the test's `git clone` exited.

**Investigation.** Not sufficient by themselves, in standalone scripts: spawn options, same-tick batches, overlapping long children, destroying streams after `close`, and recursive `fs.watch`. The watcher's `persistent` and `recursive` options make no difference. What the real process has that the scripts lack: `bun test`, `bun:sqlite`, a real watched repository receiving writes, and the service's unref'd timers. `strace -f` hides the race, 81 runs with no miss.

#### Outcome (2026-11-06)

**Not reduced.** No standalone script, and no strict probe of the real test, left a child's exit or close undelivered on macOS (Bun 1.4.4, macOS 27.2, arm64, 18 cores, git 2.56.0, host load average 35 to 60 from other work throughout, so no CPU hogs were added). Linux was not tried this round. The attempts, about 415,000 children:

| Script | What it adds | Children | Probe | Result |
| --- | --- | --- | --- | --- |
| Spawn loop, 32 at once, `/usr/bin/true` | file capture, `Bun.spawn` pipes, `node:child_process` pipes; each with and without recursive `fs.watch` plus writes, `bun:sqlite` writes and 20 unref'd timers | 123,000 | unsettled 3 s after spawn | 0 |
| The real test's pattern: `git status`, `rev-parse` and `diff` at once, then `checkout`, on a watched repository dirtied every iteration | every tenth iteration a nested `bun -e` and a `git clone`; `bun:sqlite` writes; file capture through `Bun.spawn` | 21,000 | `ps` shows a zombie 1 s after spawn | 2 "lost" |
| The same, one ingredient at a time | none / clone only / nested only | 20,000 / 20,500 / 20,500 | as above | 0 / 2 "lost" / 0 |
| The same, watching `exited` after a "loss" | all ingredients | 16,800 | as above, then 60 s more | 2 "lost", both delivered 4 ms and 69 ms later |
| The same, with a probe that starts no process | all ingredients | 42,000 | unsettled 1 s after spawn, then 5 s with no spawn | 9 slow children (`git clone`, `checkout`, `diff`), all settled on their own 1.05 to 3.3 s after spawn |
| The same, reaping a stranded child itself | all ingredients | 25,200 | as above | none stranded |
| The same, zombie seen through `waitid(WNOWAIT)` | file capture | 50,400 | unreaped zombie for 5 s with no exit | 0; 5 exits delivered 22 to 152 ms after the child was first seen as a zombie |
| The same, the old `runCommand`'s shape | `node:child_process`, piped output, settle on `close` | 50,400 | unreaped zombie for 5 s with no `exit`, or no `close` 5 s after `exit` | 0 |
| The script below, as attached | `node:child_process` with file capture, then with pipes, three runs each | 25,200 | as above | 0 |

The real test on this branch's file capture, 150 runs each:

| Probe | Misses | Result |
| --- | --- | --- |
| The production watchdog (`ps` 1 s after spawn), counting each time it settles a command | 0 | 10 "lost exits" |
| The watchdog disabled; `waitid(WNOWAIT)` from 1 s after spawn, a loss being an unreaped zombie for 5 s | 0 | **0 lost**; 3 exits delivered 22 to 30 ms after the child was first seen as a zombie, two of them nested `bun test` runs |

What this changes:

- **A zombie seen at one instant is not a lost exit.** Bun takes milliseconds to handle a child's exit, and a child that runs about a second (a `git clone` or a nested `bun test` under load) can be caught as a zombie in that window. Every "lost" count above that came from a single `ps` look was that: the strict probe found those children's exits delivered. The production watchdog makes the same single look, so its 10 settlements here, and possibly the 8 recorded in [case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#load-and-stress-runs-2026-11-03-to-2026-11-04) as settled at its first check, were early reads of an exit Bun was about to report. That is harmless: the status read is the same.
- **The earlier evidence still stands.** The macOS traces in case 1537 showed a child as `Z <defunct>` for a whole 10 s, and the Linux fdinfo showed a delivered, unarmed `EPOLLONESHOT`. Both were on the old pipe-based `runCommand`. Neither has been seen since, with the strict probe, on file capture, or in a standalone pipe script.
- The script used for the last standalone row, a tidied merge of the two before it, is kept below so the work can resume from it, and as the attempt to attach to the upstream report.

<details>
<summary>Standalone probe: <code>lost-child-event-probe.ts</code></summary>

```ts
// Does Bun lose a child's exit or close event? macOS, Bun only, no other code.
// usage: bun lost-child-event-probe.ts [iterations=1000] [capture=file|pipe]
// Each iteration dirties a watched Git repository and runs four short `git`
// commands; every tenth also starts a nested Bun and a `git clone`. A child is
// reported LOST when it has been an unreaped zombie for 5 s with no exit event,
// or its exit fired and its close did not follow within 5 s. The zombie check is
// waitid(WNOWAIT): it starts no process and reaps nothing, so it cannot wake Bun.
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, unlinkSync, watch, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";

const iterations = Number(process.argv[2] ?? 1000);
const capture = process.argv[3] ?? "file";
const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
  waitid: { args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});
const siginfo = new Int32Array(32);
// P_PID = 1; WEXITED | WNOHANG | WNOWAIT = 0x25; si_pid is siginfo_t's fourth int.
const isZombie = (pid: number) =>
  (siginfo.fill(0), symbols.waitid(1, pid, siginfo, 0x25) === 0 && siginfo[3] === pid);

const root = mkdtempSync(path.join(os.tmpdir(), "bun-lost-child-event-"));
const repo = path.join(root, "repo");
const git = ["git", "-c", "user.name=t", "-c", "user.email=t@e.invalid"];
Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
writeFileSync(path.join(repo, "README.md"), "# r\n");
Bun.spawnSync([...git, "-C", repo, "add", "."]);
Bun.spawnSync([...git, "-C", repo, "commit", "-qm", "r"]);
watch(repo, { recursive: true }, () => {});
const db = new Database(path.join(root, "db.sqlite"));
db.run("create table t (v text)");
setInterval(() => db.run("insert into t values (?)", [String(Date.now())]), 5).unref();

const captureFile = () => {
  const file = path.join(root, `capture-${crypto.randomUUID()}`);
  const fd = openSync(file, "wx+", 0o600);
  unlinkSync(file);
  return fd;
};

let spawned = 0;
let lost = 0;
function run(argv: string[], cwd = repo): Promise<void> {
  spawned += 1;
  const fds = capture === "file" ? [captureFile(), captureFile()] : [];
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    detached: true,
    stdio: ["ignore", fds[0] ?? "pipe", fds[1] ?? "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  let exitAt = 0;
  let closed = false;
  child.once("exit", () => (exitAt = Date.now()));
  return new Promise((resolve) => {
    child.once("close", () => {
      closed = true;
      for (const fd of fds) closeSync(fd);
      resolve();
    });
    setTimeout(async () => {
      let zombieAt = 0;
      while (!closed) {
        if (!exitAt && !zombieAt && isZombie(child.pid!)) zombieAt = Date.now();
        if (zombieAt && !exitAt && Date.now() - zombieAt >= 5_000) break;
        if (exitAt && Date.now() - exitAt >= 5_000) break;
        await Bun.sleep(20);
      }
      if (closed) return;
      lost += 1;
      const what = exitAt ? "close (exit fired)" : "exit (unreaped zombie)";
      console.log(`LOST ${what}: ${argv.slice(0, 2).join(" ")} pid=${child.pid} after ${spawned} spawns`);
      resolve();
    }, 1_000);
  });
}

const started = Date.now();
const background: Promise<void>[] = [];
for (let i = 0; i < iterations; i++) {
  writeFileSync(path.join(repo, "README.md"), `dirty ${i}\n`);
  if (i % 10 === 0) background.push(run([process.execPath, "-e", "setTimeout(() => {}, 200)"]));
  if (i % 10 === 5) {
    const target = path.join(root, `clone-${i}`);
    background.push(run(["git", "clone", "-q", repo, target], root).then(() => rmSync(target, { recursive: true, force: true })));
  }
  await Promise.all([
    run(["git", "status", "--porcelain=v2", "-z"]),
    run(["git", "rev-parse", "HEAD"]),
    run(["git", "diff", "--numstat", "HEAD"]),
  ]);
  await run(["git", "checkout", "-q", "--", "README.md"]);
}
await Promise.all(background);
console.log(JSON.stringify({ bun: Bun.version, capture, iterations, spawned, lost, ms: Date.now() - started }));
rmSync(root, { recursive: true, force: true });
process.exit(0);
```

</details>

**Decisions.**

- **How to reduce it?**
  - **Delete from the real test until the stall stops, on a scratch copy of the old pipe capture, with the `waitid(WNOWAIT)` probe (recommended).** Moved to [to-do 6900](6900-reproduce-lost-child-event-on-pipe-capture.md).
    - Pros: starts from the only code that showed a real loss; the strict probe stops a delay being counted as a loss.
    - Cons: needs the old capture restored outside `main`; it may not reproduce either, in which case the macOS half of the report rests on the 2026-11-04 traces alone.
  - **Keep growing a standalone script.**
    - Pros: the result is directly reportable.
    - Cons: about 1.1 million standalone children across both rounds, with no loss under a strict probe and no signal about what to add next.

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

**Re-checked on 2026-11-06 at `e6c3da899`, after E3 (#1833) merged: nothing to move.**

- Every asynchronous capture in `apps/backend/src/core/change-tracking/` already goes through `runCommand` or `runCommandBuffer`: `capture.ts`, `diff-bodies.ts`, `git-scopes.ts`, `restore.ts`, `environment-projector.ts` and `worktree-owner.ts`. Only `capture.ts` still names `node:child_process`, for a synchronous `execFileSync` inside `CONTAINER_CAPTURE_HELPER`, script text run with `node -e` inside the container, which cannot import `runCommand` and does not wait on Bun's asynchronous readers. `service-test-support.ts` and the six tests use synchronous `execFileSync` as fixtures.

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
| `apps/backend/src/core/review-worktree-fingerprint.ts` | Moved | Still self-contained script text run inside the environment, so it cannot import `runCommand`. It now captures `git` into unlinked files itself. |
| `apps/backend/src/core/storage-backups.ts` | Moved | The database copy keeps stdin as its liveness pipe, which `runCommand` would close, and takes stdout and stderr through unlinked files from `openCaptureFile`. Settles on exit or at its own deadline. |
| `apps/backend/src/core/web-annotation-evidence-files.ts` | Moved | `runContainerEvidenceScript`. No import left. Now has a 60 s deadline. |
| `apps/backend/src/core/web-annotation-source-checks.ts` | Moved | `runContainerPathCheck`. No import left. |
| `packages/protocol/src/node/standalone-service.ts` | Moved | `runFile`. No import left. |
| `packages/protocol/src/node/workspace-change-probe.ts` | Moved | `runGit`. No import left. |
| `apps/backend/src/core/agent-accounts-login.ts` | Live follower | Interactive login: parses the prompt from output while the child runs. |
| `apps/backend/src/core/codex-host-login-refresh.ts` | Live follower | JSON-RPC over stdin and stdout with `codex app-server`; success comes from a response, and exit before it is a failure. |
| `apps/backend/src/core/commands-servers.ts` | Live follower | Type only. Long-running local bridge servers, spawned through `local-server-runtime.ts`. |
| `apps/backend/src/core/cursor-sdk-bridge.ts` | Live follower | Interactive `--login` child read while it runs. |
| `apps/backend/src/core/local-server-runtime.ts` | Live follower | Type only. Owns long-running servers started through `spawnCommand`. |
| `apps/backend/src/core/shell.ts` | Live follower | Defines `spawnCommand` and `spawnParentBoundCommand`. Unchanged; the capture primitive moved out to `command-capture.ts`. |
| `apps/backend/src/core/transcript-artifacts/media-stream-container.ts` | Live follower | Type only. Starts the container media reader through `spawnCommand` for streaming. |
| `apps/backend/src/core/transcript-artifacts/media-stream.ts` | Live follower | Type only. Streams a media reader's output as it arrives. |
| `apps/backend/src/preview-relay-supervisor.ts` | Live follower | Long-running `docker exec` relay carrying framed traffic in both directions. |
| `packages/protocol/src/node/ssh/context.ts` | Live follower | The injectable `spawn` starts the tunnel in `tunnel-starter.ts`. The one-shot `runBoundedCommand` moved to the context's `capture`. |
| `apps/backend/src/core/change-tracking/ (every other file)` | Nothing to move | Re-checked 2026-11-06 after E3 merged: asynchronous captures use `runCommand` or `runCommandBuffer`. Importers in that folder have their own rows. |
| `apps/backend/src/core/change-tracking/capture.ts` | Not fitting | Re-checked 2026-11-06 after E3 merged. Synchronous `execFileSync` inside a `node -e` container helper; its own Git reads use `runCommandBuffer`. |
| `apps/backend/src/core/change-tracking/git-scopes.ts` | Nothing to move | Re-checked 2026-11-06 after E3 (#1833) merged. No `node:child_process` import; uses `runCommandBuffer`. |
| `apps/backend/src/core/change-tracking/service-test-support.ts` | Not fitting | Re-checked 2026-11-06. Test support using synchronous `execFileSync`. |
| `apps/backend/src/core/commands-containers.ts` | Nothing to move | Re-checked 2026-11-05 after S-0080 merged. No `node:child_process` import; uses `runCommand` and `dockerExec`. |
| `apps/backend/src/core/commands-files.ts` | Nothing to move | Re-checked 2026-11-05 after E-0580 merged. No `node:child_process` import; uses `runCommand` and `dockerExec`. |
| `apps/backend/src/core/diff-stats-service.ts` | Nothing to move | Re-checked 2026-11-05 after E-0580 merged. Starts no process; scans and reads are injected. |
| `docker/image-manifest.ts` | Not fitting | Re-checked 2026-11-05 after S-0080 merged; the only importer under `docker/`. Synchronous `spawnSync` of `--version` in an image-build script outside the backend; `runCommand` is async. |
| `apps/backend/src/core/agent-credential-files.ts` | Not fitting | No import: a comment names the module. |
| `packages/protocol/src/node/command-capture.ts` | Not fitting | This is `runCommand`, with file capture, and the backend re-exports it. Under Bun it uses `Bun.spawn`; the import is for where `Bun` is absent. |
| `apps/backend/src/core/design/export-writer.ts` | Not fitting | Its spawn seam lets tests withhold a payload from a real child. Shared capture supports Node, so runtime compatibility no longer requires pipes. Left on pipes until a stall is seen; its deadline settles the call. |
| `apps/backend/src/core/fix-path.ts` | Not fitting | Synchronous `execFileSync` of the login shell in a synchronous startup path; `runCommand` is async. |
| `apps/backend/src/core/process-tree.ts` | Not fitting | Type only. Signals a child it is given and captures nothing. |
| `apps/backend/src/core/public-api/exec-worker.ts` | Not fitting | Self-contained script text run inside the environment, so it cannot import `runCommand`. It supervises a detached command and follows its output. |
| `apps/backend/src/core/review-validation-worker.ts` | Not fitting | Self-contained script text run inside the environment, so it cannot import `runCommand`. It supervises project commands live and makes synchronous `git` reads. |
| `apps/backend/src/core/transcript-artifacts/fixtures/fake-preview-worker.ts` | Not fitting | Test fixture. Its child has stdio ignored and captures nothing. |
| `apps/backend/src/core/transcript-artifacts/preview-worker-prepare.ts` | Not fitting | `stageContext` runs with stdio ignored, so there is no capture to move. |
| `apps/backend/src/core/validation-failure-classifier.ts` | Not fitting | Function source serialised and run inside the environment, with `require` passed in. Its child calls are synchronous. |
| `apps/backend/src/preview-browser-harness.ts` | Not fitting | Test-only entrypoint: synchronous certificate setup plus long-running dev servers. |
| `apps/backend/src/preview-test-pki.ts` | Not fitting | Test-only: synchronous `openssl` calls. |
| `packages/protocol/src/node/claude-linux-sandbox.ts` | Not fitting | Protocol cannot import the backend, and this probe is synchronous (`spawnSync`). |
| `packages/protocol/src/node/host-test-scheduler.ts` | Not fitting | Protocol cannot import the backend, and this `ps` is a synchronous call in the scheduler factory. |

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
| `apps/backend/src/core/change-tracking/capture-container.test.ts` | Not fitting | Re-checked 2026-11-06. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/change-tracking/capture-stat-reuse.test.ts` | Not fitting | Re-checked 2026-11-06. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/change-tracking/capture.test.ts` | Not fitting | Re-checked 2026-11-06. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/change-tracking/diff-bodies-lookup.test.ts` | Not fitting | Re-checked 2026-11-06. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/change-tracking/manifest-cache.test.ts` | Not fitting | Re-checked 2026-11-06. Test using synchronous `execFileSync`. |
| `apps/backend/src/core/change-tracking/object-store-write-path.test.ts` | Not fitting | Re-checked 2026-11-06. Test using synchronous `execFileSync`. |
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

**Context.** This was 8 children in about 21,000 under heavy CPU load (175 runs of 122 children). Zombies hold a process-table entry and no memory to speak of, and they go when the backend exits. Task 2's strict probe (2026-11-06) suggests most watchdog settlements are early reads of an exit Bun reports milliseconds later, so a zombie that stays is rarer than that count, but the 10 s zombies traced on 2026-11-04 show it happens.

**Investigation.** Node and Bun expose no `waitpid`, and the watchdog reads the status with `ps` instead. `bun:ffi` can call it. Measured on 2026-11-06 with Bun 1.4.4:

- A child started outside Bun (`posix_spawnp` through `bun:ffi`) stays a zombie until `waitpid` is called, so Bun runs no catch-all reaper (`waitpid(-1)`) that a targeted reap could race.
- When Bun handles an exit after someone else reaped the child, its own `waitpid` fails with `ECHILD`: `Bun.spawn`'s `exited` rejects, and `node:child_process` emits `error` (`ECHILD`) and then `exit` with a null code and signal. Nothing else happens, and Bun reaps nothing in its place.
- `waitpid` on a PID that is not this process's child returns `-1` and touches nothing.

#### Outcome (2026-11-06)

`reapAfterLostExit` (`packages/protocol/src/node/lost-exit-reaper.ts`) is called when a capture settles while its runtime still reports no exit for the child: `runCommand` (`command-capture.ts`) and the database copy's supervisor (`storage-backups.ts`), the two places that settle from `watchForLostExit`. It does nothing except on macOS under Bun. There, after a 2 s grace and then at doubling gaps up to 30 s, twelve checks in all, it calls `waitpid(pid, WNOHANG)` only when all of these hold at that moment:

- the PID is one the capture started and handed over (never this process, PID 1, or a non-integer);
- the runtime still reports no exit for it (`exitCode` and `signalCode` both null), so the runtime has not reaped it and the PID cannot yet name another process;
- `ps` shows that PID as a zombie whose parent is this process.

The checks and the call run in one synchronous step on the JavaScript thread, so Bun cannot reap the child between them. A PID that is gone, belongs to another parent, or is reported by the runtime is dropped; one still running is checked again and given up after the last check; an unknown `ps` answer counts as a check. At most 256 children are watched; past that a child is left as it was, never queued. Timers are unref'd, so a pending reap never keeps the process alive. `child.reaped`, `child.reap-abandoned` and `child.reap-unavailable` (area `process`) record what happened; `lostExitReaperStats()` counts it.

Tests:

- `lost-exit-reaper.test.ts`: the rules, against a fake process table whose `waitpid` answers as the kernel does: no wait for another parent's zombie, a running child, a PID that is gone, an unknown `ps` answer, a reported exit, or PID 1 and this process; the bound; a PID watched once.
- `lost-exit-reaper-darwin.test.ts` (macOS, real processes, short grace): an untracked zombie of this process is reaped and its PID then names no process; a running child of this process is left running; a zombie whose exit was reported meanwhile is left; another process's zombie and its parent are left exactly as they were, and the kernel refuses `waitpid` on it.
- `command-capture-reap.integration.test.ts` and `storage-backups-reap.integration.test.ts` (macOS, slow tier: they wait on the production timings): through `runCommand` and the database copy, a child Bun never reports settles with its real outcome and then no zombie remains; a late `ECHILD` rejection from Bun after the reap is ignored.

**Decisions.**

- **What to do about them?**
  - **Call `waitpid` through `bun:ffi`, guarded by the rules above (recommended, implemented).**
    - Pros: removes the zombie; the kernel limits it to this process's children and the checks limit it to the one PID; a late event from Bun only rejects a promise the settled capture ignores.
    - Cons: a native call; if Bun delivered a stranded exit after the reap *and* the PID had meanwhile been given to a new child of this process, Bun's late `waitpid` would take that child's status. macOS hands out PIDs in sequence, so that needs the PID space to wrap between the reap and Bun's next look; it was not observed.
  - **Count them first, and act only if a long-lived backend accumulates enough to matter.**
    - Pros: no native call.
    - Cons: leaves the zombies the ticket asked to remove.

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

### Task 5: the captures that did not fit at first

These were split out of task 5 and finished on 2026-11-05 (to-do 6060, now deleted). None had been seen to stall. Each decision took the recommended option unless it says otherwise.

**Fingerprint script.** Chose to capture into unlinked files inside the script over relying on the caller's bound, which would keep reporting a stall as a failed validation guard. It keeps its reason codes, and it now settles at `git`'s exit, so a helper holding the output no longer delays it. The cost is a second copy of the capture idea in script text, size limits that are polled, and hashing after exit.

**Database copy.** Chose to keep stdin as the liveness pipe and take stdout and stderr through unlinked files, over a "keep stdin open" option on `runCommand` that only this caller would use. The backend now has its own deadline, past the supervisor's, and a result with no exit status is a failure even when the verdict was written.

**Design export helper.** Left on pipes until a stall is seen. Its deadline already settles the call, so it cannot hang, and it is imported by Node-based browser tests whose `DesignExportSpawn` seam withholds a payload from a real child. A stall would report a completed write as an unknown outcome after 30 s. Injecting a `runCommand` transport would have stopped production using pipes but left tests exercising a transport production does not use.

**Protocol captures.** Moved `command-capture.ts` and `shell-process-state.ts` to `packages/protocol/src/node/`, with the backend re-exporting the capture and charging its metrics through `setCommandCaptureMetrics`. `runGit`, `runFile` and SSH `runBoundedCommand` use it. Leaving them would have avoided a change to a package every bridge depends on, but kept SSH's deadline signalling without settling.

The re-check changed one thing. The to-do took it that these all run under Bun, but Electron's main process runs the SSH adapter and a bridge bundle can start under `node`, so `Bun.spawn` alone would have broken SSH in the desktop app. The capture starts a child through `node:child_process` where `Bun` is absent, with the same file capture and classification; a test bundles it for Node and runs it under a real `node`. The alternative of leaving SSH on `context.spawn` with capture files would have left two capture paths. SSH gained a `capture` seam beside the tunnel's `spawn`, and its tests' fake answers that seam.

Results that change: the bridges' `runGit` with a stdin payload fails past its output limit, where it truncated, and SSH helpers stop once stderr passes 1 MiB, where they kept running, keeping `maxStderrBytes` of it as before. In the backend, the protocol captures now count towards its recurring-work metrics.

**`spawnCommand` callers.** Every production caller on 2026-11-05, with what became of it. "One payload" callers moved to `runCommand`; an output limit now fails where they truncated.

| Caller | Kind | Outcome |
| --- | --- | --- |
| `runContainerEvidenceScript`, writer and remover (`web-annotation-evidence-files.ts`, through `commands-registry-terminal.ts`) | One payload, no deadline | Moved, with a 60 s deadline. |
| `runContainerPathCheck` (`web-annotation-source-checks.ts`) | One payload | Moved. |
| `write_container_file` (`commands-registry-terminal.ts`) | One payload, no deadline | Moved through `runContainerWrite` (`container-write.ts`), with a 120 s deadline. |
| `write_initial_prompt_attachments` (`commands-registry-terminal.ts`) | One payload, no deadline | Moved the same way. |
| `writeEnvironmentReviewPackage` (`commands-review.ts`) | One payload | Moved through `writeContainerReviewPackage`. |
| `GraphArtifactStore` write (`graph-artifacts.ts`) | One payload | Moved through `writeContainerReviewPackage`. |
| `copyOutBounded` (`docker-copy-out.ts`) | One payload, raw bytes | Moved to `runCommandBuffer`. `maxOutputBytes` covers `oversized`, and `maxStderrBytes` was added so Docker's own message cannot read as an oversized file. |
| `pipeContainerPath` (`container-replacement.ts`) | Streams between two children | Stays on pipes: a whole workspace has to flow while both run, so a file does not fit. Its deadline only signalled them, so it now also settles the step as failed. |
| `ContainerLogService` (`container-log-service.ts`) | Live follower | Unchanged. `docker logs -f`. |
| `LocalServerRuntime` (`local-server-runtime.ts`) | Live follower | Unchanged. Long-running local bridge servers. |
| `media-stream-container.ts` | Live follower | Unchanged. Streams a media reader as it arrives. |
| `spawnParentBoundCommand` (`shell.ts`), used by `container-oom-events.ts` | Live follower | Unchanged. `docker events`. |

Chose to move the one-payload callers over only adding a deadline to `runContainerEvidenceScript`, because a deadline alone would still report a stalled command that succeeded as failed. Their tests moved to a `run` seam or a fake `docker` on `PATH`.

**Lost-exit tests.** `@orkestrator/protocol/testing/lost-exit` makes `Bun.spawn`'s `exited` never settle while the real child runs, which is the lost event as far as a capture can tell. On Linux a lost exit fails at the deadline rather than being recovered. Only macOS has a readable status, as before.

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

### Task 1: drafted, not filed

Wrote the report into the to-do and filed nothing, as the ticket required: filing is outward-facing and the user's call. The draft cites only what was traced (the Linux fdinfo line and the macOS 10 s zombies) and says plainly that there is no reduced case, rather than presenting task 2's early single-look counts as losses. The canary check is left to the user, since installing a canary Bun on this host was not asked for.

### Task 2: what counts as a lost exit

Counted a child as lost only when it had been an unreaped zombie for 5 s with no exit event, read through `waitid(WNOWAIT)`, rather than a zombie seen once by `ps` 1 s after spawn. The single look is what the watchdog and the first rounds of this work used, and the strict probe showed every such "loss" it was checked against was an exit Bun delivered milliseconds later. `waitid(WNOWAIT)` starts no process, so it cannot be what wakes Bun, and reaps nothing, so it cannot change the outcome it measures. The cost is that the earlier counts, including the watchdog's, are no longer comparable with the new ones.

### Task 2: no reduced case, and no new script in the repository

The ticket allowed recording the attempts when no case reduced. The last standalone script is kept in the to-do, under a `<details>` block, rather than committed as a file: it does not reproduce, it needs `bun:ffi` and macOS, and as a file under `scripts/` it would be linted and typechecked as tooling nobody runs. The next attempt, on the old pipe capture, is [to-do 6900](6900-reproduce-lost-child-event-on-pipe-capture.md), because it needs code outside `main`.

### Task 6: reap, with a grace, only what the runtime has not reported

Chose to call `waitpid` through `bun:ffi` over counting first, because the ticket asked for the zombies to be reaped. The rules come from what was measured: Bun has no catch-all reaper, a late Bun `waitpid` only fails with `ECHILD`, and the kernel refuses `waitpid` for another process's child. The 2 s grace exists because task 2 showed Bun can be tens of milliseconds behind a child's exit: a child Bun reports within the grace is never touched. The reaper keys on the runtime's own `exitCode`/`signalCode` rather than on how the capture settled, so a command settled by a timeout or an output limit whose child Bun has not yet reported is covered too, and one Bun reports later is dropped.

### Task 6: where the reaper is called

Called from the two places that settle through `watchForLostExit`: `runCommand` and the database copy. `review-worktree-fingerprint.ts` has its own watchdog but runs as script text inside a short-lived `node` or `bun` process whose zombies go when it exits, so it was left alone. Only macOS under Bun reaps; Node never lost an exit, and on Linux the exit always arrived.

### Task 6: logging

Added three events to the `process` area rather than a new area, because the reaper is about this process's own children, as the area's other events are. `child.reaped` is `info` and carries only the PID and how long after settling it was reaped; nothing about the command is logged.

### Task 5: `change-tracking/` re-checked, nothing moved

E3 (#1833) merged, so the folder was re-checked on 2026-11-06. Its asynchronous captures already use `runCommand` or `runCommandBuffer`; what still names `node:child_process` is a synchronous call inside container script text and test fixtures. So nothing moved, and its rows in the importer table changed from Held to Nothing to move or Not fitting.

## Constraints and rationale

- Never raise a test deadline, skip or retry to hide this; see the [flake rules](../../tests/flaky-tests/0000-index.md).
- Never settle a command as successful when its output may be missing.
- Flake case 1537 and task 2 of [CI shard report 0010](../../reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md) were closed by task 3. Reopen the case if the test misses its deadline again.

## Needs verification

- Whether the lost event happens on x86-64 Linux. All Linux evidence is aarch64 in a container; CI's misses suggest it does, but no CI run has reported a step.
- How often it reaches users through the remaining pipe captures: the design export helper and `pipeContainerPath`.
- Whether a Bun canary build still has it.
- Whether the macOS lost exit still happens at all on file capture: the strict probe saw none in 150 runs of the real test on 2026-11-06, under host load only. If it does not, the reaper only ever finds the exit reported at its first check ([to-do 6900](6900-reproduce-lost-child-event-on-pipe-capture.md)).
- The reaper's real-world count: `child.reaped` in a long-lived macOS backend's log says how often it acts.

## Related

- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)
- [CI shard report 0010](../../reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md)
- [0030 test suite and CI health](0030-test-suite-and-ci-health.md)
- [To-do 6900](6900-reproduce-lost-child-event-on-pipe-capture.md): the next reduction attempt, on the old pipe capture

## Replaces

Nothing; new observation.
