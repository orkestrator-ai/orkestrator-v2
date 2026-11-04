# Project Git mirror follow-ups

## Task analysis

Analysed 2026-11-04 against `main` at `a8bdce44`.

What the per-project Git mirror ([1202](../cross-cutting/1202-efficiency-review-follow-ups.md) task 15, DK-13) left. See [Project Git mirror](../../architecture/container-lifecycle.md#project-git-mirror) and [Project Git mirrors](../../development/disk-usage.md#project-git-mirrors).

### Tasks

1. **Seed a project's first mirror from its host checkout**: save the first download. Status: open.
2. **List mirrors in Settings > Disk usage**: only `mise run disk:report` shows them. Status: open.

### 1. Seed a project's first mirror from its host checkout

**Problem.** The first container environment of a project pays twice: its own blobless clone and, in the background, the mirror's full download (86 MiB and 322 MiB on the two repositories measured).

**Context.** `buildMirror` in `apps/backend/src/core/project-git-mirror.ts` fetches everything from the remote. Many projects have a host checkout at `project.localPath` that already holds most of those objects.

**Investigation.** Not attempted. This would be a fetch from the checkout's path first and then from the remote, or objects borrowed with an alternate and repacked. A checkout's refs and config are shaped by whatever ran in it, so reading it from a process that writes a mirror every container reads needs care. Nothing here was measured.

**Decisions.**

- **How should it be seeded?**
  - **Leave it until a real project shows the cost matters (recommended).**
    - Pros: one extra download per project, once, in the background, delaying nothing.
    - Cons: a slow link pays it in full.
  - **Fetch from the checkout's objects, then from the remote, in the same build.**
    - Pros: the first build downloads only what the checkout lacks.
    - Cons: reads a checkout agents may have changed. Objects are hashed on the way in, but it needs a rule for which refs to trust, and one more thing to go wrong in a build.

### 2. List mirrors in Settings > Disk usage

**Problem.** Settings > Disk usage breaks down each environment, and a mirror belongs to a project rather than an environment, so it appears nowhere in the app.

**Context.** `mise run disk:report` has a row for them (`gitMirrorRow` in `scripts/disk-report.ts`). Each is at most 2 GiB.

**Investigation.** Not attempted.

**Decisions.**

- **Where should it appear?**
  - **Leave it in the report until someone asks (recommended).**
    - Pros: no new UI for a bounded cache that removes itself with its project.
    - Cons: a user looking in Settings for used space will not find it.
  - **A per-project line in Settings > Disk usage.**
    - Pros: the whole cost in one place.
    - Cons: a new section and a size read per project.

## Needs verification

- A real rootless daemon. The mirror is world-readable inside an owner-only directory for that case, and a clone as `--user 12345` passes, but the mount was not run under rootless Docker, where a daemon recreating a removed source does so as the host user rather than root.
- Docker Desktop. Bind mounts there go through its file sharing, so the clone time is likely to differ, and whether the data directory is shared by default was not checked.
- A restricted network: the measurements used the default bridge with `NETWORK_MODE=full`. The clone still reaches the remote for its refs, through the same allowlist as before, but this was not run behind a firewall.
- A real-stack `dev:test` profile with a freshly built image. The live test binds this checkout's script over an older image's copy and calls the mirror functions directly, so the image's own capability probe and `createDockerContainer` were not run together against real Docker.

## Related

- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), task 15.
- [Efficiency report](../../reports/2026-10-27-efficiency.md), DK-13.
- [0022 container resource budgets](0022-container-resource-budgets-and-performance.md): out of scope here, and a workspace volume's budget now has to fit a full history.
