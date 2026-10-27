# A reset profile name fails to boot its container fixture on Docker Desktop

Checked against `main` at `930189337` (2026-10-26).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Reproduce and diagnose the stale bind source**: show whether Docker Desktop refuses a bind under a deleted and recreated directory tree, and whether production can reach it. Status: open.
2. **Fix or contain it, and qualify a stop, reset and restart**: choose a fix once the cause is known, then prove that one profile name boots a container fixture twice. Status: open (depends on 1).

### 1. Reproduce and diagnose the stale bind source

**Problem.** After `mise run dev:reset`, restarting the same profile name with a container fixture failed twice on Docker Desktop 29.9.2 (macOS, Apple Silicon) with "bind source path does not exist". Agents reuse fixed profile names, so they hit a confusing boot error.

**Context.** Found while qualifying [0020](../containers-and-environments/0020-container-state-observation.md). The file's hypothesis is Docker Desktop file sharing holding state for the deleted tree; its open question is whether `dev:reset` leaves something behind that staging trusts.

**Investigation.** The file's proposed repro (recreate a directory "at the same path" and bind it again) does not match how the paths are built. A staged path is `<dataDir>/portable-inputs/<key>/<revision>/...`: `<key>` is a SHA-256 of the environment id (`environmentStateKey`, `apps/backend/src/core/environment-state-paths.ts:33`), environment ids are `randomUUID()` (`apps/backend/src/core/storage-shared-core.ts:2003`), and every revision is named from a timestamp plus a random suffix and renamed into place from a `.partial` directory (`apps/backend/src/core/portable-inputs.ts:780`-`:857`). So a restarted profile never reuses a staged path. What it does reuse are the ancestors: `dev:reset` deletes the whole profile root, or every child of `data/` except `toolchains` (`removeProfileState`, `apps/desktop/scripts/dev/profile-io.ts:162`), and the next start recreates `profiles/<p>/data/portable-inputs/` at the same place. That points at a cache keyed on a recreated ancestor (for example a virtiofs directory entry or inode cache), consistent with a fresh profile name working at once. Nothing in `dev:reset` is left for staging to trust: the environment, its key and its revisions are all new. Production removes revisions only through `pruneInputRevisions` (`portable-inputs.ts:977`), which deletes whole revisions but leaves their parent, and never reuses a name; the `portable-inputs` root and a per-environment parent are only removed with the data directory or the environment, whose id is never reused. Production exposure therefore looks low, but unproven.

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

**Context.** The workaround is a new profile name. The qualification in the file is a stop, reset and restart of one name with a container fixture.

**Investigation.** No code change has been made since the report. If the repro confirms an ancestor cache, the tooling can avoid recreating the same ancestor; if it confirms nothing, the cause is elsewhere and the decision below is premature.

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

After `mise run dev:reset --profile <p>`, starting the same profile name again
with a container fixture failed twice in a row on Docker Desktop 29.9.2
(macOS, Apple Silicon):

```text
Error response from daemon: invalid mount config for type "bind": bind source path does not exist:
/host_mnt/Users/<user>/Library/Application Support/orkestrator-v2-dev/profiles/<p>/data/portable-inputs/<hash>/...
```

The first failure named a staged `claude-config` directory under a revision
the host listing showed as present; the second named the revision root. A
new profile name started cleanly at once with the same image, flags and
credentials.

## Current state

- Seen on 2026-10-26 with
  `mise run dev:test --profile <p> --fixture --fixture-environments local,container --credential-source claude --agent-platforms claude`:
  the first start of the name worked, stop and reset, a second start failed,
  reset, a third start failed; a fresh name worked.
- Not diagnosed. It looks like Docker Desktop's file sharing still holding
  state for the deleted directory tree, but that was not confirmed. Whether
  it also hits production (an environment whose staged inputs are removed
  and recreated at the same path) is unknown.

## Outstanding work

### Code

1. Reproduce outside the profile tooling: create, bind, delete and recreate a
   directory at the same path under `~/Library/Application Support`, then
   bind it again. If Desktop refuses the recreated path, decide whether
   staged-input revisions (or reset profiles) should never reuse a path, and
   whether production can hit it.

### Qualification

- Whatever the fix, a stop, reset and restart of one profile name with a
  container fixture boots.

## Constraints and rationale

- Agents reuse profile names (the docs suggest fixed names such as
  `claude-warm-qa`), so a failure here costs a confusing boot error rather
  than a wrong result.

## Open questions

- Is this Docker Desktop's virtiofs cache, or does `dev:reset` leave
  something behind that the staging code then trusts?

## Related

- [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md)
  (where it was found).
