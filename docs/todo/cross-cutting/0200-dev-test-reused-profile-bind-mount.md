# A reset profile name fails to boot its container fixture on Docker Desktop

Checked against `main` at `79f3bc97e` (2026-10-28), Docker Desktop 4.97.0
(engine 29.9.2, macOS, Apple Silicon, default VirtioFS file sharing).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`; worked 2026-10-28.

### Tasks

1. **Reproduce and diagnose the stale bind source**: show whether Docker Desktop refuses a bind under a deleted and recreated directory tree, and whether production can reach it. Status: done.
2. **Fix or contain it, and qualify a stop, reset and restart**: choose a fix once the cause is known, then prove that one profile name boots a container fixture twice. Status: done.

### 1. Reproduce and diagnose the stale bind source

**Problem.** After `mise run dev:reset`, restarting the same profile name with a container fixture failed twice on Docker Desktop 29.9.2 (macOS, Apple Silicon) with "bind source path does not exist". Agents reuse fixed profile names, so they hit a confusing boot error.

**Context.** Found while qualifying [0020](../containers-and-environments/0020-container-state-observation.md). The file's hypothesis is Docker Desktop file sharing holding state for the deleted tree; its open question is whether `dev:reset` leaves something behind that staging trusts.

**Investigation.** The file's proposed repro (recreate a directory "at the same path" and bind it again) does not match how the paths are built. A staged path is `<dataDir>/portable-inputs/<key>/<revision>/...`: `<key>` is a SHA-256 of the environment id (`environmentStateKey`, `apps/backend/src/core/environment-state-paths.ts:33`), environment ids are `randomUUID()` (`apps/backend/src/core/storage-shared-core.ts:2003`), and every revision is named from a timestamp plus a random suffix and renamed into place from a `.partial` directory (`apps/backend/src/core/portable-inputs.ts:780`-`:857`). So a restarted profile never reuses a staged path. What it does reuse are the ancestors: `dev:reset` deleted the whole profile root, or every child of `data/` except `toolchains` (`removeProfileState`, `apps/desktop/scripts/dev/profile-io.ts`), and the next start recreated `profiles/<p>/data/portable-inputs/` at the same place. Nothing in `dev:reset` is left for staging to trust: the environment, its key and its revisions are all new.

**Findings (2026-10-28).** Repros ran with plain `docker run --mount type=bind` on throwaway trees under `~/Library/Application Support`, outside any profile:

- A directory Docker Desktop has resolved, deleted and recreated under the same name can stay stale: every new bind under it fails with "bind source path does not exist", including binds of children with fresh names. It did not clear after 2 minutes or after `touch`ing the parent on the host.
- Deleting a leaf (or a revision with its children) and creating a sibling with a new name under a kept parent always worked. Recreating the same leaf under a kept parent also worked.
- With only short-lived `docker run --rm` binds, the failure was intermittent (for example 1 of 3 rounds). When a long-lived container held the bind and read through it, as the fixture's workload does, and was then stopped and removed, recreating the profile-shaped tree failed 6 of 6 times, with or without a 3 second gap. The `--keep-toolchains` shape (only `portable-inputs` recreated) failed 3 of 3.
- One bind of a kept ancestor, or of the recreated directory itself, cleared the stale entry.
- Through `mise run dev:test` the old reset behaviour reproduced the exact reported error on the second start of a name (cycle E below).

So it is Docker Desktop's file sharing, not something `dev:reset` left behind. The hazard is precise: a fixed-name directory on a bind source's path that is deleted and recreated. On the staged-input path those are `profiles/<p>`, `data` and `portable-inputs`.

Production exposure is low. `pruneInputRevisions` (`portable-inputs.ts:977`) deletes whole revisions under a kept per-environment directory and never reuses a name, which is the always-working case. The `portable-inputs` root and a per-environment directory are only removed with the data directory or the environment, and environment ids are never reused. The remaining production path is a user deleting and recreating the whole data directory while Docker Desktop keeps running. The bind would then fail clearly until Docker Desktop restarts; nothing is corrupted.

**Decisions.**

- **What should the repro recreate?**
  - **A recreated ancestor with a new child (recommended).** Under `~/Library/Application Support`, create `a/b/c1`, bind `c1`, delete `a`, recreate `a/b`, create a new `c2`, bind `c2`; repeat with the same leaf name for completeness.
    - Pros: matches what `dev:reset` and the staging code actually do; separates "same path" from "recreated parent".
    - Cons: two repros instead of one.
  - **The same leaf path only, as the file says.**
    - Pros: simplest to run.
    - Cons: tests a case the product never produces, so a pass would prove nothing.
- **Where to run it?**
  - **Directly with `docker run --mount type=bind` on the affected Mac, outside any profile (recommended).**
    - Pros: isolates Docker Desktop from the profile tooling; no Orkestrator process involved.
    - Cons: needs the same Docker Desktop version and file-sharing implementation (virtiofs) as the failure.
  - **Through `mise run dev:test` with a container fixture.**
    - Pros: exactly the reported path.
    - Cons: cannot tell a Docker Desktop cache from a tooling bug.

### 2. Fix or contain it, and qualify a stop, reset and restart

**Problem.** Until fixed, a reused profile name cannot boot a container fixture on Docker Desktop after a reset.

**Context.** The workaround was a new profile name. The qualification in the file is a stop, reset and restart of one name with a container fixture.

**Investigation.** The repro confirmed a cache keyed on recreated ancestors, so the tooling must not recreate them. Two shapes were compared under the container-held trigger, each 3 times: keeping `profiles/<p>`, `data` and `portable-inputs` and emptying them (3 of 3 passed); and keeping `profiles/<p>` with a new generation-named data directory (3 of 3 passed). A generation directory under a *recreated* profile root failed 1 of 3. A kept root with a recreated `data` also failed 1 of 3.

**Fix.** `removeProfileState` (`apps/desktop/scripts/dev/profile-io.ts`) now empties the profile root, its data directory and `data/portable-inputs` instead of deleting them, in both reset modes, without following symlinks. A full reset or prune therefore leaves only those empty directories. `pruneProfiles` (`profile-cleanup.ts`) skips such a skeleton silently. It deletes one only under `--older-than` once it is that old, bottom-up with `rmdir`, so anything that appears inside makes the deletion fail rather than be deleted.

**Qualification.** Profile `todo0200-c57ecd`, run with `mise run dev:test --profile todo0200-c57ecd --fixture --fixture-environments local,container --credential-source claude --agent-platforms claude`, then `dev:stop` and `dev:reset` after each start:

| Cycle | Before start | Result |
| --- | --- | --- |
| A | No profile | Ready in 25 s; fixture container running with both host binds |
| B | New reset (skeleton kept) | Ready in 20 s |
| C | New reset | Ready in 15 s; inside the container the origin bind showed the fixture commit and the staged `.claude`/`.claude.json` were present |
| D | New reset | Ready in 20 s; then the profile root was deleted by hand, as the old reset did |
| E | Old reset | **Failed**: `bind source path does not exist: /host_mnt/.../profiles/todo0200-c57ecd/data/portable-inputs/<key>/<revision>/files/claude.json/.claude.json` |
| F | New reset after E | Failed the same way: the kept directories were the stale ones |
| G | One `docker run --rm --mount type=bind,source=<profile root>,readonly ... true` | Ready in 20 s |

B and C are the two consecutive passing cycles. D and E show that the old behaviour still fails on this machine. F and G show that a name the old reset already poisoned needs one bind of its profile root (or a Docker Desktop restart), as now documented in `docs/development/agent-testing.md`.

**Decisions.**

- **How should it be fixed if Docker Desktop refuses binds under a recreated ancestor?**
  - **Give each profile generation its own data directory (for example a generation suffix written into `profile.json`), so a reset never recreates the same ancestor path (recommended).**
    - Pros: fixes it for every profile and every Docker Desktop version; no dependency on upstream.
    - Cons: touches profile path resolution in `apps/desktop/scripts/dev/`, and every consumer that assumes `profiles/<p>/data`.
  - **Document the workaround (restart Docker Desktop, or use a new name) and report upstream.**
    - Pros: no code; correct if it is purely an upstream bug.
    - Cons: agents keep hitting it, since the docs suggest fixed names such as `claude-warm-qa`.
  - **Have `dev:reset` keep the `data/` and `portable-inputs/` directories and delete only their contents.**
    - Pros: smallest change.
    - Cons: only helps if the cached ancestor is that exact directory; leaves a partly reset tree.
- **What counts as a pass?**
  - **Two consecutive stop, reset and restart cycles of one name with `--fixture-environments local,container` boot on Docker Desktop (recommended).**
    - Pros: the failure reproduced twice in a row, so one success is weak evidence.
    - Cons: a few extra minutes.
  - **A single cycle.**
    - Pros: quicker.
    - Cons: the original sequence worked once before failing.

## Assumptions and decisions

### Task 1: repro shape

- **Choice.** The recommended recreated-ancestor repro, with new and same leaf names. Extended with a matrix of profile-shaped trees and a long-lived container holding the bind.
- **Why.** The plain repro reproduced, but only intermittently with short-lived binds. A matrix with isolated bases showed the reported shapes passing 5 of 5 until a container held the bind as the fixture does. Without that trigger a fix could not be judged.

### Task 1: where to run it

- **Choice.** Directly with `docker run --mount type=bind` first (recommended), then through `dev:test` for the before and after comparison.
- **Why.** The direct runs isolate Docker Desktop and pick the fix. The `dev:test` runs prove the fix on the reported path and show that the old reset still fails there (cycles D and E).

### Task 2: the fix

- **Choice.** Keep the profile root, `data` and `data/portable-inputs` across a reset or prune, emptied (the third option, extended to the profile root). The recommended generation data directory was not taken.
- **Why.** As written, the recommended option does not stop a reset recreating a bind ancestor. The default reset deletes the profile root, which is itself on every bind path, together with the `profile.json` that would hold the generation. A generation directory under a recreated root failed 1 of 3. Making it work needs the root kept anyway. A `--keep-toolchains` reset would also have to move `toolchains/` into the new generation, and its activation symlinks hold absolute targets under the old data directory. The third option's con ("only helps if the cached ancestor is that exact directory") is answered by the evidence: the hazard is exactly the fixed-name directories on the bind path, and keeping them passed every round.
- **Cons.** It protects the staged-input path only. A future host bind from another directory under a profile would need the same treatment. A reset or prune leaves three empty directories.

### Task 2: what pruning does with the empty directories

- **Choice.** Pruning keeps the same empty directories as reset (it uses the same removal), skips them silently, and deletes them only under `dev:prune --older-than`.
- **Why.** Start-up pruning removes the profiles of deleted checkouts, and agents run fixed names from disposable worktrees, so a pruned name is often started again. Deleting the root there would bring the failure back. Leaving the directories forever would pile up after one-off names (`isolated-browser` resets a `qa-browser-<uuid>` profile every run). The age rule handles that without reporting them on every start.

### Task 2: pass criterion

- **Choice.** Two consecutive stop, reset and restart cycles (recommended), plus a same-name baseline with the old reset.
- **Why.** The failure reproduced twice in a row originally, so two passes are the minimum. The baseline shows that the passes came from the fix, not from a machine that no longer reproduces it.

### Task 2: names poisoned before the fix

- **Choice.** Document a one-off manual recovery (bind the profile root once, or restart Docker Desktop). `dev:test` does not do it automatically.
- **Why.** It only affects names reset before this change. Automating it would run an extra container on every start and depend on undocumented Docker Desktop behaviour.

### Task 2: the fixture's local git origin bind

- **Choice.** Unchanged.
- **Why.** Agent-test containers also bind `<profile>/fixtures/origin.git` with `-v` (`commands-containers.ts:342`). `fixtures/` is still deleted on reset, and `prepareFixtureRepository` recreates `origin.git` at the same path on every start, reset or not. In all 5 successful starts the origin was readable inside the container. `-v` creates a missing source instead of failing, and keeping `fixtures/` would not stop `origin.git` itself being recreated. Recorded under open questions instead.

## Current state

- Fixed in the dev tooling: a reset or pruned profile name boots a container fixture again on Docker Desktop (qualified above).
- Names reset before the fix may stay stuck until their profile root is bound once or Docker Desktop restarts.

## Constraints and rationale

- Agents reuse profile names (the docs suggest fixed names such as
  `claude-warm-qa`), so a failure here costs a confusing boot error rather
  than a wrong result.

## Open questions

- Can the fixture origin bind (`-v <profile>/fixtures/origin.git`) hit the same
  stale entry, since `origin.git` is recreated at the same path on every start?
  Not seen in 5 starts; if it is, the symptom would be a workspace clone failure,
  not a bind error. On native Docker (Linux, 2026-11-01) a related failure was seen: a
  container still running from the previous start keeps the deleted
  `origin.git` and its fetches fail. That is a running bind, not a stale cache;
  see [2180](2180-fixture-restart-orphans-earlier-environments.md).

## Related

- [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md)
  (where it was found).
