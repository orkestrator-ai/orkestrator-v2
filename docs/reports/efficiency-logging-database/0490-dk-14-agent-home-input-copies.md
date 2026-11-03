# Agent-home inputs are copied in full per environment and again on every start

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Skip the start copy with a stamp**: skip the copy into `$HOME` when the inputs revision has not changed. Status: open.
2. **Shared host cache for staging**: avoid a full copy per environment on the host. Status: open.
3. **Bounded parallel copy**: copy with bounded parallelism. Status: open.

### 1. Skip the start copy with a stamp

**Problem.** Each container start copies agent-home inputs into `$HOME` again, even when they have not changed.

**Context.** Decided 2026-11-01 in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 15: do this now, ahead of the measurement gate. Order taken 2026-11-02: DK-14 next, once the build then editing `portable-inputs.ts` had merged, then [DK-13](0500-dk-13-shared-clone-mirror.md). Since then #1589 and #1670 have changed that file.

**Investigation.** The container carries the revision as a label (`DOCKER_LABEL_INPUTS_REVISION`, `apps/backend/src/core/commands-containers.ts:489`). `docker/network-policy-entrypoint.sh:172-203` relays staged inputs, and `docker/entrypoint.sh` copies them (`:708-748` for Claude, through `copy_agent_file` and `copy_agent_directory`). None of the entrypoint or portable-input code reads or writes a stamp. A label is fixed when the container is created, so it cannot by itself show that a running container's inputs moved.

**Decisions.**

- **What makes the skip safe?**
  - **A stamp file in `$HOME` holding the revision, checked before the copy and written only after a complete one, with the revision reaching the entrypoint in the environment (recommended).**
    - Pros: the report's fix; a failed copy leaves no stamp, so the next start retries.
    - Cons: a file the agent removed from `$HOME` is not restored until the revision changes, which differs from today; credentials still need their own handling.
  - **Compare per-file sizes and times before each copy.**
    - Pros: restores a removed file.
    - Cons: still walks every input on each start.

### 2. Shared host cache for staging

**Problem.** `stagePortableInputs` copies the allowlisted inputs into a new revision for each environment.

**Context.** The report suggests a content-addressed host cache with hard links or reflinks.

**Investigation.** Each call creates a fresh revision under the environment's own directory (`apps/backend/src/core/portable-inputs.ts:1005-1020`, `:985-987`), and its doc comment says only staged subtrees are mounted, "never another environment's revisions". A hard link shares an inode, so one environment writing to it would reach another's copy unless the mounts are read-only.

**Decisions.**

- **Which link?**
  - **Reflink where the filesystem supports it, and copy otherwise (recommended).**
    - Pros: copies stay independent, so isolation is unchanged; falls back cleanly.
    - Cons: no saving on filesystems without reflinks.
  - **A content-addressed cache with hard links.**
    - Pros: saves on every filesystem.
    - Cons: shared inodes across environments need proof that nothing can write through them.

### 3. Bounded parallel copy

**Problem.** Inputs are copied one file at a time.

**Context.** The report lists this as a third, optional step.

**Investigation.** One `ProviderCopier` per provider walks each source in order (`portable-inputs.ts:1033`); its budget is shared across every provider (`:1020`).

**Decisions.** None: use a bounded pool only if the measurement after task 1 still shows copy time, keeping the budgets exact.

## Constraints and rationale

Container storage rules in `docs/architecture/container-lifecycle.md` apply, as does the staged-input isolation above. New caches need byte and count bounds, per the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep).

## Needs verification

- Input sizes on real hosts; the report rates its size confidence Medium and measured nothing.
- Whether anything in the image relies on the copy recreating a removed file on start.

## Related

- [Efficiency report, G](../2026-10-27-efficiency.md#g-desktop-toolchain-docker-image-protocol-and-cli)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 15
- [0022 container resource budgets](../../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md)
