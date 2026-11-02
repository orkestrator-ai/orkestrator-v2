# A `--fixture` restart orphans the previous start's fixture environments

Found on 2026-11-01 while running
[0048](../transcripts-and-observation/0048-recurring-work-qualification.md)
tasks 3 and 4 on Linux with native Docker.

## Task analysis

Analysed 2026-11-01 against `main` at `93b99bfba`, from one live run (profile
`q48`, `--fixture --fixture-environments local,container`) and the code.
Rechecked 2026-11-02 against `main` at `38d55ee14`: unchanged, `seedFixture`
still called `prepareFixtureRepository` (delete and recreate) and
`create_environment` on every start.

### Tasks

1. **Keep or retire the previous start's fixture environments**: after `dev:stop` and a second `dev:test --fixture`, the first start's container has a dangling origin and its local worktree points at a deleted repository, yet both stay in the sidebar. Status: done (2026-11-02).

### 1. Keep or retire the previous start's fixture environments

**Problem.** The documented restart (`dev:stop`, then `dev:test` with the same flags) re-runs fixture seeding. `prepareFixtureRepository` (`apps/desktop/scripts/dev/fixture.ts`) deletes and recreates `fixtures/test-project` and `fixtures/origin.git`, and `seedFixture` creates a second `fixture-local` and `fixture-container`. The first pair is left broken:

- the first container's bind of `fixtures/origin.git` still names the deleted directory, so inside it `/orkestrator-agent-test-origin.git` is empty and every fetch fails as `no-remote` (`does not appear to be a git repository`);
- the first local worktree's `.git` file points into the deleted `test-project/.git/worktrees/`, so Git refuses it (`gitfile does not point to a valid repository`).

A spec that selects `getByText("fixture-container").first()` then picks the broken one. Starting without `--fixture` keeps the fixture and its environments intact (used in 0048's run).

**Context.** On Linux a bind mount holds the directory it resolved at container start, so a deleted and recreated source is not seen until the container restarts. This differs from the Docker Desktop stale-bind cache in [0200](0200-dev-test-reused-profile-bind-mount.md), whose open question asked whether the origin bind can be hit; on native Docker it is, but through a running container rather than a stale cache.

**Investigation.** Reproduced once: first start at 02:49, container created 02:49:29; second start re-created `origin.git` at 02:50:46 (a different inode from the one the container held). The fixture commit is deterministic (fixed author and dates), so both starts produce the same `f0018d8` creation commit, and a refilled origin would serve the old containers' clones.

**Decisions.**

- **What should a restart with `--fixture` do?**
  - **Reuse the existing fixture when the project is already registered: skip recreating the repository and the environments (recommended).**
    - Pros: the documented restart keeps working environments; no duplicates in the sidebar.
    - Cons: a restart no longer gives a pristine fixture; suites that rely on one must reset first (`dev:reset` already exists for that).
  - **Refill `origin.git` and `test-project` in place (empty, then re-init) instead of deleting them.**
    - Pros: the binds and worktree links keep resolving; minimal change.
    - Cons: still creates a second pair of environments; an earlier worktree's branch metadata in `test-project/.git` is lost anyway.
  - **Delete the previous start's fixture environments before seeding.**
    - Pros: always one clean pair.
    - Cons: deletes containers and worktrees on every restart, which a debugging session may still want.

## Assumptions and decisions

### Task 1: reuse rather than refill or delete

Took the recommended option. `seedFixture` (`apps/desktop/scripts/dev/fixture.ts`)
now reads `get_projects` first. When the fixture project is already registered
and `fixtureRepositoryIntact` finds both `test-project/.git` and
`origin.git/HEAD`, it skips `prepareFixtureRepository`, so the directory a
running container binds and the worktree links in `test-project/.git/worktrees/`
are untouched. Uncommitted changes in `test-project` survive a restart too;
`dev:reset` remains the way to get a pristine fixture.

### Task 1: what "skip the environments" means

Reading the recommendation literally (create nothing on a restart) would make a
restart that asks for more than the first start (first `local`, then
`local,container`) silently omit the container. Chose instead: for each
requested kind, reuse the project's environment with the same `fixture-<kind>`
name and environment type, and create one only when none exists. A reused
environment is started only when its status is not `running`, because
`start_environment` on a running environment re-runs its setup. An environment
an earlier start created but this start did not request is left as it is.

### Task 1: a registered project whose repository is gone

When the project is registered but the repository or origin is missing (for
example the fixture directory was removed by hand), the repository is prepared
again as before and new environments are created, since every earlier one
points at the deleted copy. The project registration is kept. Those earlier
environments stay listed; deleting them is left to the user or `dev:reset`
rather than done automatically (the third option, rejected above).

### Task 1: evidence

Unit tests in `apps/desktop/scripts/dev/fixture.test.ts` run the seeding against
an in-memory gateway and real Git: a fresh profile still prepares, registers,
creates and starts each environment; a second seed issues no
`create_environment`, keeps `origin.git`'s inode, keeps a worktree added after
the first seed working and starts only the stopped environment; a restart that
asks for an extra kind creates just that one; a missing repository is prepared
again.

Live, 2026-11-02 on Linux (beelink), profile `fx2180-reuse`,
`dev:test --fixture --fixture-environments local --headless-electron
--no-agent-credentials`: start, `dev:stop`, start again. After the second start
the project still had one `fixture-local` with the same id and status
`running`, `origin.git` and `test-project` kept their inodes, and in that
environment's worktree `git status` and `git fetch origin` both succeeded. The
profile was then stopped and reset. A container environment was not run live
(see Needs verification).

## Needs verification

- The same restart with `--fixture-environments local,container` on native
  Docker: the first start's container should still fetch from
  `/orkestrator-agent-test-origin.git` after the second start. Reusing
  `origin.git` without deleting it is what the bind needs, but it has not been
  observed with a container.
