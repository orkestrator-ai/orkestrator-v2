# Each environment clones from the remote again

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Per-project mirror**: clone new environments from a shared local mirror. Status: open (depends on [DK-14](0490-dk-14-agent-home-input-copies.md), by the order taken in 1202).

### 1. Per-project mirror

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

## Constraints and rationale

Container storage rules in `docs/architecture/container-lifecycle.md` apply: no removal outside lifecycle operations. A read-only mount keeps one environment from changing another's source, and a mirror must not widen what a restricted container can read. The mirror needs byte bounds, per the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep).

## Needs verification

- Whether blobless clones pay many lazy round trips for history-heavy diffs, which the report and 1202 both leave unverified and which changes this file's value.
- Credentials: how a host-side mirror fetches a private repository a container's own credential can reach.

## Related

- [Efficiency report, G](../2026-10-27-efficiency.md#g-desktop-toolchain-docker-image-protocol-and-cli)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 15
- [0022 container resource budgets](../../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md)
