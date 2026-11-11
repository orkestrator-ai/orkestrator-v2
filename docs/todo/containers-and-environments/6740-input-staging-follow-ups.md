# Input staging follow-ups

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766` (first analysed 2026-11-05 at `cbe0f9a5b`).

What E25 (DK-14, report part `0490`) left after the host staging copy learned to reflink. See [Portable inputs](../../architecture/container-lifecycle.md#portable-inputs-staged-inputs) and the closing check of E25 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), which holds the measurements.

### Tasks

1. **Reflinks on macOS**: clone staged files on APFS. Status: open (needs a Mac).
2. **A cold first start from a reflinked revision**: decide whether the slower first start matters. Status: done (2026-11-11, left as it is).
3. **The in-container first start of a many-file home**: find what the 5–6 s for 5,202 files is spent on. Status: done (2026-11-11).
4. Input sizes of real homes: moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) on 2026-11-10.
5. **Fewer processes per copied directory**: cut the per-unit cost task 3 found. Status: open.

### 1. Reflinks on macOS

**Problem.** `FileCloner` in `apps/backend/src/core/portable-inputs.ts` clones only on Linux, so a Mac copies every staged file in full, although APFS can clone.

**Context.** The clone must come from the descriptor `copyRegularFile` opened `O_NOFOLLOW` and checked against the listed inode, never from the path, or a file swapped in between would be staged. On Linux that is `/proc/self/fd/<fd>`, which reopens that same file. macOS has no such path, and `/dev/fd/<fd>` there duplicates a descriptor on open rather than naming a file, so `clonefile(2)` cannot use it.

**Investigation.** macOS has `fclonefileat(srcfd, dst_dirfd, name, flags)`, which clones from a descriptor. Neither Node nor Bun exposes it; `fs.copyFile` with `COPYFILE_FICLONE` resolves the source path. Not tried on a Mac: beelink, where this was re-checked on 2026-11-11, is Linux, so a `bun:ffi` call to a macOS libc symbol can be neither built against nor run here. It stays for an agent on a Mac node; nothing in it needs the user.

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

**Investigation.** A reflinked file is a new inode with no cached pages, while a copy the backend has just written is still in the page cache, so the entrypoint's first read of a clone goes to the disk (here dm-crypt over NVMe). Restarts were unchanged (508–635 ms), because the stamps copy nothing. Measured on one host under varying load, two containers per cell, with `output/efficiency/e25-container-starts.ts` (throwaway, not committed): stage with `cloneFiles` on or off, bind the revision with `stagedInputMountArguments`, `docker start` until `waitForContainerBoot`, three starts per container. Closed 2026-11-11 on the recommended option: task 3 shows the first start of a many-file home is dominated by process starts, not by reading bytes, so warming the page cache would buy little where it matters.

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

**Investigation.** Profiled 2026-11-11 on beelink with E25's fixtures, without building an image: a copy of the image's `entrypoint.sh` with each copy and stamp function wrapped in `$EPOCHREALTIME` timing lines, and a count of processes started (the PID counter across the import), bind-mounted over the original in a `--network none` container of `orkestrator-v2:qual-0019-498b6876` (throwaway `output/efficiency/scripts/input-starts.ts`, not committed; the same run as [4580](4580-input-stamp-follow-ups.md) task 2). The host's load average was 43–58 throughout, so the absolute times are about three times E25's; the shares hold across all six first starts measured (rootful, rootful with a forced relay, rootless):

| Fixture | Import | Processes | `copy_agent_directory` | Of which recording the copy | Hashing (`agent_input_manifest`) |
| --- | --- | --- | --- | --- | --- |
| `medium`, 5,202 files | 15.7–21.7 s | 9,116–9,466 | 605 calls, 94–97% of the import | 602 calls, 11% | 0.2–0.9 s, 1–4% |
| `plugins`, 1,322 files | 2.3–4.7 s | 1,099–1,254 | 65 calls, 60–73% | 62 calls, 6–8% | 0.4–1.6 s, 16–33% |

So the time goes on processes, about 15 per directory unit: `copy_agent_directory`'s bound and link checks (two `find`s and a `head` for the entry count, a `find` for links, `du`, a `find` on the destination), `mkdir`, `cp -R`, and the `find` in `agent_input_record_copy`. `medium` has 600 skill directories, each its own unit, which is why it costs four times `plugins` with a fifth of the bytes. Hashing matters only for large files. Restarts stayed at 0.6–1.8 s on the same host: the stamps' manifest and home check (`agent_input_home_matches`) are the whole of it.

**Decisions.**

- **What to do first?**
  - **Profile one first start with timing lines, as 1202 task 15 did, before changing the script (recommended, done).**
    - Pros: found that process starts per directory unit dominate, not hashing, copying bytes or the walk.
    - Cons: none left; the change itself is task 5.
  - **Hash and copy a directory unit in one process.** Now task 5, with the measurement to aim it.

### 5. Fewer processes per copied directory

**Problem.** Task 3: a first start spends about 15 processes on every directory unit it copies, so a home with hundreds of skills takes seconds (5.4–5.7 s for 600 skills on a quiet host) whatever their size.

**Context.** `copy_agent_directory` and `copy_agent_directory_entries` in `docker/entrypoint.sh` enforce the entry and size bounds, refuse links in the source and the destination, then `cp -R`; `agent_input_record_copy` lists what was copied for the stamp. These checks are what keep a planted link or an oversized tree out of the home, and `docker/AGENTS.md` governs changes to the entrypoint. The entrypoint runs as `node`, after root's part.

**Investigation.** Not built in this pass: it rewrites the bounded copy helpers, which needs the entrypoint's existing link and bound tests (`docker/tests/`), an image build and a rerun of task 3's profile. The checks per unit are independent of each other, so one walk can answer all of them.

**Decisions.**

- **How to cut the processes?**
  - **One `find -P` per unit printing type, size and path, read by the shell to get the entry count, any link and the byte total together, then `cp -R`, with the copy's listing taken from that same walk (recommended).**
    - Pros: about 3 processes per unit instead of 15; keeps the same rules and the same `cp`.
    - Cons: the total comes from apparent sizes rather than `du -sk`'s blocks, so the size bound changes meaning slightly and its tests need updating.
  - **Walk a parent directory (for example all of `skills`) once and decide per child from that listing.**
    - Pros: the largest saving for many small skills.
    - Cons: a child changed between the walk and its copy is checked on stale data, which the per-unit check closes today.
  - **Leave it.**
    - Pros: no change to a boundary-sensitive script.
    - Cons: large skill collections keep costing seconds on every new container.

## Assumptions and decisions

### Task 2: closed without a change

The recommended option was to leave the cold first start alone. Task 3's profile supports that: the time that matters on many-file homes is process starts, which a warmed page cache does not change.

### Task 3: profiled with a bind-mounted entrypoint

An image built from this branch's base (`498b68766`) was already on the host with entrypoints byte-identical to the branch's, so the profiled copy was bind-mounted over it in throwaway containers instead of building a profiled image; the containers were removed by ID afterwards. The wrappers run each helper inside `||`, which turns off `set -e` within it; the helpers already handle their own failures, and every start imported the expected 7 inputs.

## Related

- to-do 1202 efficiency follow-ups, task 15 (retired 2026-11-10).
- [4580 input stamp follow-ups](4580-input-stamp-follow-ups.md).
- To-do 6741 Git mirror access (retired 2026-11-10; see [Project Git mirror](../../architecture/container-lifecycle.md#project-git-mirror)).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 4, reading manifest counts from a real data directory) moved there on 2026-11-10.
