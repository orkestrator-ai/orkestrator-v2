# Stop writing the GitHub token into the container's `~/.gitconfig`

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Use a credential helper that reads the token file**: the token is persisted in `insteadOf` URLs. Status: open.

### 1. Use a credential helper that reads the token file

**Problem.** The token sits in `~/.gitconfig` as well as its credential file, so `git config --list`, a `git remote` output or a copied config can show it.

**Context.** The report prefers a helper, as on the host (`apps/backend/src/core/github-git-credentials.ts:29-40`). The container already has the file, `/tmp/orkestrator-ai/github-token` (`apps/backend/src/core/agent-credential-files.ts:9`, `docker/runtime-env.sh:10`).

**Investigation.** Two places write the URL: the sync command (`apps/backend/src/core/commands-files.ts:2392-2394`) and setup (`docker/workspace-setup.sh:374-377`). Both setup and the entrypoint also clear `credential.helper`, because host helpers name absolute paths (`docker/workspace-setup.sh:353`, `docker/entrypoint.sh:1254`). The sync command runs from the backend against whatever image is running. It also removes old sections (`apps/backend/src/core/commands-files.ts:2381-2387`).

**Decisions.**

- **How to roll it out?**
  - **Add a helper to the image behind a capability; the backend's sync writes the URL only for an image without it (recommended).**
    - Pros: old images keep working; a current image never holds the token in its config; the removal step cleans old values.
    - Cons: a capability to carry, and the `insteadOf` path stays until old images are gone.
  - **Have the sync command install an inline helper that `cat`s the file, on any image.**
    - Pros: no image change, so every container benefits at its next sync.
    - Cons: the setup and entrypoint steps that clear `credential.helper` must then be reconciled, and those live in the image anyway.

## Constraints and rationale

- The `git@github.com:` rewrite (`apps/backend/src/core/commands-files.ts:2394`) carries SSH remotes onto HTTPS and needs to stay in some form, without the token: a URL rewrite plus the helper does this.
- This removes one copy. The agent can still read the token file: see [0070](0070-h5-host-github-token-default.md).

## Related

- [Security report, §6 Informational](../2-26-10-27-security.md#6-informational) (I3)
- [0070](0070-h5-host-github-token-default.md)
