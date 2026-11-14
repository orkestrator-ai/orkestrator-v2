# Make the "Environment Files" setting copy what it says

From [7571](../cross-cutting/7571-removal-candidates-needing-a-decision.md)
task 4. Settings offers an "Environment Files" field (`envFilePatterns`)
saying matching files "will be copied into containers", but the backend never
reads it. On 2026-11-14 the user (maintainer) chose to implement the copy,
with a security review of copying arbitrary patterns into containers.

## Task analysis

Analysed 2026-11-14 against `main` at `066992035`. Nothing has been built.

### Tasks

1. **Security review of copying pattern-matched files**: decide the rules a matched file must pass before it is copied, written down before any code. Status: open.
2. **Copy the files that match `envFilePatterns`**: into containers and local worktrees, under task 1's rules, with the default patterns giving today's behaviour. Status: open (depends on 1).

### 1. Security review of copying pattern-matched files

**Problem.** The copy list is fixed to `.env` and `.env.local` (plus
`opencode.json` for containers), and each of those is checked carefully
because the checkout is repository content. A user-supplied glob widens that
to any file a branch can commit, so the checks must hold for every match.

**Context.** `apps/backend/src/core/container-project-seed-files.ts` reads
each seed file before the container is created: a regular file, not a link,
whose real path stays inside the project, at most
`PROJECT_SEED_FILE_MAX_BYTES` (1 MiB); the bytes read are the bytes copied
(`docker cp`), and a refused file is skipped with its reason recorded on the
container (`DOCKER_LABEL_PROJECT_SEED_REFUSED`). Local worktrees copy
`.env` and `.env.local` in `commands-environment.ts` (about line 2361), with
an `lstat` check so a committed link is never followed. The key is a
required field of the global config schema
(`packages/protocol/src/contract/domains/config/models.ts`) and is edited in
`apps/web/src/components/settings/GlobalSettings.tsx`.

**Investigation.** Questions for the review: which pattern syntax (and
whether `**` or absolute and `..` patterns are refused); a bound on match
count and total bytes; whether matches are taken from the project checkout
only (never the worktree a branch produced); how a match that is a directory,
a link, a device or outside the project is refused and reported; whether a
pattern may name a file already staged by another path (`opencode.json`,
credentials staged by the entrypoint); and whether restricted and full
network modes differ. Rootless `docker cp` refusals
([7549](7549-rootless-docker-cp-refusals.md)) apply to every extra file.

**Decisions.**

- **Where do the rules live?**
  - **One validator shared by the fixed seed files and the pattern matches,
    extending `container-project-seed-files.ts` (recommended).**
    - Pros: one set of checks, already reviewed for `.env`; local and
      container paths agree.
    - Cons: the fixed files' code moves.
  - **A separate validator for pattern matches.**
    - Pros: the existing code stays untouched.
    - Cons: two rule sets that can drift.
- **Bounds?**
  - **A count bound and a total-bytes bound, with the per-file 1 MiB kept;
    over the bound, copy none and report it (recommended).**
    - Pros: predictable; a broad pattern cannot fill a container.
    - Cons: a user with many small files must narrow the pattern.
  - **Copy up to the bound and skip the rest.**
    - Pros: something is copied.
    - Cons: which files arrive depends on order, silently.

### 2. Copy the files that match `envFilePatterns`

**Problem.** The setting does nothing.

**Context.** As task 1. The stored default must reproduce today's set, so
existing configs see no change.

**Investigation.** Not started. A live case on a rootless daemon (like
`container-project-seed-docker.test.ts`) should create an environment with a
matched file, a refused link and a file over the bound.

**Decisions.**

- **What about a stored config whose patterns differ from the default?**
  - **Honour them as written, and show refused matches in the setup terminal
    as the seed files already do (recommended).**
    - Pros: the setting finally means what it says.
    - Cons: a user who typed a broad pattern long ago gets those files on the
      next environment.
  - **Reset stored patterns to the default once.**
    - Pros: no surprise copies.
    - Cons: discards a user's setting.

## Assumptions and decisions

### Implement the copy, with a security review (user decision, 2026-11-14)

The user (maintainer) chose on 2026-11-14 to implement the copy (the
recommended option of 7571 task 4) rather than remove the control, and asked
for a security review of copying arbitrary patterns into containers. Task 1
is that review; task 2 builds it.

## Constraints and rationale

- The checkout is repository content: nothing a branch commits may make the
  backend read or copy a file outside the project, or follow a link.
- Records and logs name refusal reasons, never file contents.

## Related

- [7571](../cross-cutting/7571-removal-candidates-needing-a-decision.md) task 4.
- [7549](7549-rootless-docker-cp-refusals.md): `docker cp` refusals on
  rootless daemons, and the seed delivery the user decided to fix.
- [Container lifecycle](../../architecture/container-lifecycle.md).

## Replaces

Nothing; new work from 7571 task 4.
