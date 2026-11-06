# The inputs section shows an empty box for a staged revision with no providers

Found during [5860](5860-legacy-host-mounts-live-evidence.md) task 2's live
run on 2026-11-06.

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`.

### Tasks

1. **Say something when nothing was staged**: a staged runtime with no providers shows only the "Agent inputs" heading. Status: open.

### 1. Say something when nothing was staged

**Problem.** After the row's rebuild in 5860's live run, the environment's
inputs section showed the heading "Agent inputs" over an empty box. The
runtime had a staged revision, but no provider was staged into it, and
nothing in the section says so.

**Context.** `EnvironmentInputsSection.tsx` renders `status.providers` as a
list when the mode is `staged`, then the missing, disabled and revoked
notes, each only when non-empty. `environmentInputStatus`
(`apps/backend/src/core/portable-input-status.ts`) returns `staged` with an
empty `providers` list when the manifest records none.

**Investigation.** Seen on a credential-free `dev:test` profile with only
Codex enabled: an agent-test profile stages only authorized providers and no
Git identity, so the manifest was empty and no provider was missing (Codex
was not authorized, so it is not "selected"). Outside agent-test profiles,
Git identity is always selected, so the same view needs a host with no
enabled agent configuration and nothing for Git to stage; how often that
happens is not known. Screenshot of the observed state:
`output/visual-previews/legacy-5860-inputs-legacy-host-mounts-after.png` in
that run's worktree (not committed).

**Decisions.**

- **What should an empty staged revision show?**
  - **One line, "Nothing was staged into this container.", when the list and every note are empty (recommended).**
    - Pros: the box explains itself; renderer-only; no protocol change.
    - Cons: one more string and test.
  - **Hide the section, as for `none`.**
    - Pros: no empty box.
    - Cons: hides that the runtime is on staged inputs, which is the fact a user checking a rebuild wants confirmed.
  - **Leave it.**
    - Pros: no change.
    - Cons: an empty box reads as a rendering fault.

## Related

- [5860: what the legacy host mount work left for a running install](5860-legacy-host-mounts-live-evidence.md)
