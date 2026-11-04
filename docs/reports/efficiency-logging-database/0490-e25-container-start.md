# E25: Container start

This file combines 2 reports into one batch to build together. `0500` depends on `0490`.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0490](#0490-agent-home-inputs-are-copied-in-full-per-environment-and-again-on-every-start) | Medium | DK-14: Agent-home inputs are copied in full per environment and again on every start |
| [0500](#0500-each-environment-clones-from-the-remote-again) | Medium | DK-13: Each environment clones from the remote again |

## 0490: Agent-home inputs are copied in full per environment and again on every start

### Task analysis

#### Tasks

1. **Skip the start copy with a stamp**: skip the copy into `$HOME` when the inputs have not changed. Status: done (2026-11-04, `staged-inputs=5`; the choice and timings are in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 15).
2. **Shared host cache for staging**: avoid a full copy per environment on the host. Status: open.
3. **Bounded parallel copy**: copy with bounded parallelism. Status: open.

#### 1. Skip the start copy with a stamp

**Problem.** Each container start copies agent-home inputs into `$HOME` again, even when they have not changed.

**Context.** Decided 2026-11-01 in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 15: do this now, ahead of the measurement gate. Order taken 2026-11-02: DK-14 next, once the build then editing `portable-inputs.ts` had merged, then [DK-13](#0500-each-environment-clones-from-the-remote-again). Since then #1589 and #1670 have changed that file.

**Investigation.** The container carries the revision as a label (`DOCKER_LABEL_INPUTS_REVISION`, `apps/backend/src/core/commands-containers.ts:489`). `docker/network-policy-entrypoint.sh:172-203` relays staged inputs, and `docker/entrypoint.sh` copies them (`:708-748` for Claude, through `copy_agent_file` and `copy_agent_directory`). None of the entrypoint or portable-input code reads or writes a stamp. A label is fixed when the container is created, so it cannot by itself show that a running container's inputs moved.

On 2026-11-04 this was found to be incomplete: the backend rewrites a revision in place (`refreshStagedAgentAccountLogins` before every start, `scrubStagedProvider`, the MCP defaults writer), so the revision name does not change when its contents do.

**Decisions.**

- **What makes the skip safe?**
  - **A content digest of each input, compared with the stamp and with the bytes the home holds (taken 2026-11-04, replacing the recommendation below).**
    - Pros: skips only when the copy would change nothing, so a removed file is restored as it is today and a stale stamp can only cause a copy; survives in-place rewrites of the revision.
    - Cons: reads every input on each start; logins still need their own handling.
  - **A stamp file in `$HOME` holding the revision, checked before the copy and written only after a complete one, with the revision reaching the entrypoint in the environment (recommended on 2026-11-03).**
    - Pros: the report's fix; a failed copy leaves no stamp, so the next start retries.
    - Cons: misses every in-place rewrite of a revision, which would keep an old credential; a file the agent removed from `$HOME` is not restored until the revision changes, which differs from today.
  - **Compare per-file sizes and times before each copy.**
    - Pros: restores a removed file.
    - Cons: still walks every input on each start; the relay keeps only whole seconds.

#### 2. Shared host cache for staging

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

#### 3. Bounded parallel copy

**Problem.** Inputs are copied one file at a time.

**Context.** The report lists this as a third, optional step.

**Investigation.** One `ProviderCopier` per provider walks each source in order (`portable-inputs.ts:1033`); its budget is shared across every provider (`:1020`).

**Decisions.** None: use a bounded pool only if the measurement after task 1 still shows copy time, keeping the budgets exact.

### Constraints and rationale

Container storage rules in `docs/architecture/container-lifecycle.md` apply, as does the staged-input isolation above. New caches need byte and count bounds, per the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep).

### Needs verification

- Input sizes on real hosts; the report rates its size confidence Medium and measured nothing.
- Whether anything in the image relies on the copy recreating a removed file on start. No longer a question: the stamp restores one, because the home is checked as well.

## 0500: Each environment clones from the remote again

### Task analysis

#### Tasks

1. **Per-project mirror**: clone new environments from a shared local mirror. Status: open (depends on [DK-14](#0490-agent-home-inputs-are-copied-in-full-per-environment-and-again-on-every-start), by the order taken in 1202).

#### 1. Per-project mirror

**Problem.** Every new container environment fetches the repository from the remote, however many environments of that project already exist.

**Context.** Decided 2026-11-01 in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 15: do this ahead of the measurement gate. Order taken 2026-11-02: DK-14 next, then this. 1202 notes the mirror is a new per-project host resource with its own lifecycle. [0022](../../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md) records a decision against BuildKit cache mounts in the Dockerfile; that concerns image builds, not this runtime mirror.

**Investigation.** `clone_repository` in `docker/workspace-setup.sh:385-397` runs `git clone --filter=blob:none --no-tags`, then retries a full clone. No `--reference` or mirror mount appears in that script or in `apps/backend/src/core/commands-containers.ts`.

**Decisions.**

- **How does a clone use the mirror?**
  - **A per-project bare mirror mounted read-only, cloned with `--reference-if-able --dissociate` (recommended).**
    - Pros: the report's fix; `--reference-if-able` falls back to the remote; `--dissociate` leaves each environment independent of the mirror.
    - Cons: a new host resource to create, refresh, bound and clean up, and `--dissociate` still copies the objects it used.
  - **Keep cloning from the remote.**
    - Pros: nothing new to own.
    - Cons: the network cost stays; only worth choosing if the measurement shows lazy blob fetches dominate instead.

### Constraints and rationale

Container storage rules in `docs/architecture/container-lifecycle.md` apply: no removal outside lifecycle operations. A read-only mount keeps one environment from changing another's source, and a mirror must not widen what a restricted container can read. The mirror needs byte bounds, per the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep).

### Needs verification

- Whether blobless clones pay many lazy round trips for history-heavy diffs, which the report and 1202 both leave unverified and which changes this file's value.
- Credentials: how a host-side mirror fetches a private repository a container's own credential can reach.

## Related

- [Efficiency report, G](../2026-10-27-efficiency.md#g-desktop-toolchain-docker-image-protocol-and-cli)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 15
- [0022 container resource budgets](../../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md)
