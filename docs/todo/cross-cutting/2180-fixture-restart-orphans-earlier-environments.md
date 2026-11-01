# A `--fixture` restart orphans the previous start's fixture environments

Found on 2026-11-01 while running
[0048](../transcripts-and-observation/0048-recurring-work-qualification.md)
tasks 3 and 4 on Linux with native Docker.

## Task analysis

Analysed 2026-11-01 against `main` at `93b99bfba`, from one live run (profile
`q48`, `--fixture --fixture-environments local,container`) and the code.

### Tasks

1. **Keep or retire the previous start's fixture environments**: after `dev:stop` and a second `dev:test --fixture`, the first start's container has a dangling origin and its local worktree points at a deleted repository, yet both stay in the sidebar. Status: open.

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
