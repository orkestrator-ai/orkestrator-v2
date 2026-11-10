# Input staging follow-ups

## Task analysis

Analysed 2026-11-05 against `main` at `cbe0f9a5b`.

What E25 (DK-14, report part `0490`) left after the host staging copy learned to reflink. See [Portable inputs](../../architecture/container-lifecycle.md#portable-inputs-staged-inputs) and the closing check of E25 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), which holds the measurements.

### Tasks

1. **Reflinks on macOS**: clone staged files on APFS. Status: open.
2. **A cold first start from a reflinked revision**: decide whether the slower first start matters. Status: open.
3. **The in-container first start of a many-file home**: find what the 5–6 s for 5,202 files is spent on. Status: open.

### 1. Reflinks on macOS

**Problem.** `FileCloner` in `apps/backend/src/core/portable-inputs.ts` clones only on Linux, so a Mac copies every staged file in full, although APFS can clone.

**Context.** The clone must come from the descriptor `copyRegularFile` opened `O_NOFOLLOW` and checked against the listed inode, never from the path, or a file swapped in between would be staged. On Linux that is `/proc/self/fd/<fd>`, which reopens that same file. macOS has no such path, and `/dev/fd/<fd>` there duplicates a descriptor on open rather than naming a file, so `clonefile(2)` cannot use it.

**Investigation.** macOS has `fclonefileat(srcfd, dst_dirfd, name, flags)`, which clones from a descriptor. Neither Node nor Bun exposes it; `fs.copyFile` with `COPYFILE_FICLONE` resolves the source path. Not tried on a Mac: this host is Linux.

**Decisions.**

- **How to clone from a descriptor on macOS?**
  - **`fclonefileat` through `bun:ffi`, falling back to the copy on any error (recommended).**
    - Pros: keeps the descriptor-only rule; the same fallback as Linux.
    - Cons: a native call in the backend, which runs inside the packaged app; needs a Mac to qualify, and the backend may run under Node somewhere `bun:ffi` does not exist.
  - **Clone by path, then check that the path still names the checked inode.**
    - Pros: no native call.
    - Cons: a swap and swap back between the check and the clone stages bytes nobody checked, which is the race the descriptor rule exists to close.
  - **Leave macOS on the copy.**
    - Pros: nothing to build.
    - Cons: Mac users keep a full copy per environment and per revision.

### 2. A cold first start from a reflinked revision

**Problem.** On btrfs, the first start of a container whose revision was reflinked took longer than one from a copied revision: 1,701–1,747 ms against 1,174–1,277 ms for the 300 MiB plugin fixture, and 5,661–5,707 ms against 5,430–5,468 ms for the 5,202-file fixture.

**Context.** Staging the same fixtures took 213–320 ms reflinked against 763–791 ms copied, and 1,030–1,256 ms against 1,366–1,466 ms. So creation plus first start came out even: about 2.0 s either way for the plugin fixture and 6.7–6.8 s for the other. The saving that remains is disk: 300 MiB and 62.5 MiB less per revision.

**Investigation.** A reflinked file is a new inode with no cached pages, while a copy the backend has just written is still in the page cache, so the entrypoint's first read of a clone goes to the disk (here dm-crypt over NVMe). Restarts were unchanged (508–635 ms), because the stamps copy nothing. Measured on one host under varying load, two containers per cell, with `output/efficiency/e25-container-starts.ts` (throwaway, not committed): stage with `cloneFiles` on or off, bind the revision with `stagedInputMountArguments`, `docker start` until `waitForContainerBoot`, three starts per container.

**Decisions.**

- **Does the first start need anything?**
  - **Leave it (recommended).**
    - Pros: the total is even, and a host whose source files are not cached pays the disk read with a copy too, only earlier.
    - Cons: the first start alone is a few hundred milliseconds slower on large inputs.
  - **Read each cloned file once after cloning, to warm the cache.**
    - Pros: moves the read back to staging, where it was.
    - Cons: gives back the staging saving to win it at start; the pages may be evicted again before the start.

### 3. The in-container first start of a many-file home

**Problem.** A first start with the 5,202-file fixture (65 MiB) took 5.4–5.7 s, against 1.2–1.7 s for 1,322 files (300 MiB), so the cost follows the file count, not the bytes.

**Context.** This is `docker/entrypoint.sh` importing the inputs into `$HOME` (`import_agent_input`), not the host staging that report task 3 ("bounded parallel copy") was about. The stamps already skip it on a restart.

**Investigation.** Not profiled. The likely costs are per-file processes in the shell import (hashing and copying each entry). The fixture's file count is chosen, not typical; measuring real homes' input sizes needs the user's data directory and moved to [7568](../manual-test/7568-manual-test-checklist.md) (6740 task 4).

**Decisions.**

- **What to do first?**
  - **Profile one first start with timing lines, as 1202 task 15 did, before changing the script (recommended).**
    - Pros: finds whether hashing, copying or the walk dominates.
    - Cons: needs an image built from the profiled script.
  - **Hash and copy a directory unit in one process.**
    - Pros: likely the biggest win for many small files.
    - Cons: a change to the root-boundary-sensitive entrypoint without a measurement saying where the time goes.

## Related

- to-do 1202 efficiency follow-ups, task 15 (retired 2026-11-10).
- [4580 input stamp follow-ups](4580-input-stamp-follow-ups.md).
- To-do 6741 Git mirror access (retired 2026-11-10; see [Project Git mirror](../../architecture/container-lifecycle.md#project-git-mirror)).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 4, reading manifest counts from a real data directory) moved there on 2026-11-10.
