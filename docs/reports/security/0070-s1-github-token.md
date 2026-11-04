# S1: GitHub token

This file combines 2 reports into one batch to build together. Same token and the same credential sync. Needs a decision first: `0070` makes sharing opt-in and existing installs need a migration choice.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0070](#0070-stop-handing-the-host-github-token-to-every-container-by-default) | Very high | H5: the default credential, splitting container from backend use, scope warning |
| [0220](#0220-stop-writing-the-github-token-into-the-containers-gitconfig) | Low | I3: token in `~/.gitconfig`: Stop writing the GitHub token into the container's `~/.gitconfig` |

## 0070: Stop handing the host GitHub token to every container by default

### Task analysis

#### Tasks

1. **Choose the default credential for containers**: host-token sharing is on unless the user turns it off. Status: open.
2. **Separate the container credential from the backend's own**: one setting drives both today. Status: open (depends on 1).
3. **Warn about scope**: the setting does not say what the token can reach. Status: open.

#### 1. Choose the default credential for containers

**Problem.** The host `gh` token usually carries `repo`, `workflow` and `gist` across all the user's repositories. An injected agent in any container can use it over GitHub egress, which is always allowed: read every private repository, push workflows that dump CI secrets, add deploy keys, or send data out through a gist.

**Context.** The report offers per-environment repo-scoped credentials or an explicit opt-in. A stored PAT is already preferred during migration, with the comment that the host token is "potentially broader" (`apps/backend/src/core/storage-shared-config.ts:240-248`).

**Investigation.** The default is on (`packages/protocol/src/app-config-defaults.ts:48`) and absence means on (`apps/backend/src/core/github-credentials.ts:23-25`). `resolveGitHubToken` runs `gh auth token` (`:32-40`). Containers get the result at `apps/backend/src/core/commands-environment.ts:1682-1685`, `apps/backend/src/core/commands-registry-docker.ts:267` and `:657-670`. The file is `node`-owned, mode 600 (`apps/backend/src/core/commands-files.ts:2373-2377`), so the agent can read it. GitHub stays on the default allowlist (`packages/protocol/src/network-allowlist.ts:66-67`) and its ranges are always loaded (`docker/init-firewall.sh:185-213`). Every caller takes one global token, and a search of `docs/todo` and `docs/architecture` found no per-environment GitHub credential.

**Decisions.**

- **What should a container get by default?**
  - **Make host-token sharing an explicit opt-in with a scope warning (recommended).**
    - Pros: small change; no new GitHub integration; a new install exposes nothing until the user chooses.
    - Cons: a new user's first container has no GitHub access, so private clones and pushes fail until they choose. Existing installs need a migration decision: absent means on today.
  - **Per-environment repo-scoped credentials (a GitHub App installation token, or a fine-grained PAT).**
    - Pros: closes the finding properly; one environment's token reaches only its repository.
    - Cons: much larger: an App, its installation flow and token renewal, or per-repo PAT handling.
  - **Keep the default and only add the warning.**
    - Pros: no behaviour change.
    - Cons: leaves the exposure as it is for everyone who does not read it.

#### 2. Separate the container credential from the backend's own

**Problem.** Turning host credentials off today also changes the backend's own GitHub calls, so a safer container choice costs host features.

**Context.** `resolveGitHubToken` is documented as shared by container sync and the backend's API calls (`apps/backend/src/core/github-credentials.ts:27-31`).

**Investigation.** Non-container callers include `apps/backend/src/core/bug-report-service.ts:369`, `apps/backend/src/core/commands-validation.ts:111` and `apps/backend/src/core/coordinator-pr-watches.ts:257`. `gitHubCliEnv` also reads the same setting (`apps/backend/src/core/github-credentials.ts:72-80`).

**Decisions.**

- **How to split it?**
  - **A new setting for what containers receive; the existing one keeps meaning the backend's source (recommended).**
    - Pros: a user can keep host `gh` on the host and give containers nothing or a PAT.
    - Cons: one more setting to explain and carry through the node settings sync.
  - **Keep one setting.**
    - Pros: simple.
    - Cons: the opt-in in task 1 turns into all or nothing.

#### 3. Warn about scope

**Problem.** The Settings text only says that the toggle reuses the account from `gh auth login` (`apps/web/src/components/settings/GlobalSettings.sections.tsx:725-734`).

**Context.** The report asks for a scope warning alongside the opt-in.

**Investigation.** No warning text was found in that section.

**Decisions.** None: the wording follows whichever option task 1 takes.

### Constraints and rationale

- `useHostClaudeCredentials` already follows the rule that a long-lived host token should not be read at all once it is off (`apps/backend/src/core/commands-files.ts:2510-2520`). Keep to the same rule here.

### Needs verification

- Which scopes a typical `gh auth token` carries on the users' hosts: the report's list is typical, and nothing here measures it.

## 0220: Stop writing the GitHub token into the container's `~/.gitconfig`

### Task analysis

#### Tasks

1. **Use a credential helper that reads the token file**: the token is persisted in `insteadOf` URLs. Status: open.

#### 1. Use a credential helper that reads the token file

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

### Constraints and rationale

- The `git@github.com:` rewrite (`apps/backend/src/core/commands-files.ts:2394`) carries SSH remotes onto HTTPS and needs to stay in some form, without the token: a URL rewrite plus the helper does this.
- This removes one copy. The agent can still read the token file: see [0070](#0070-stop-handing-the-host-github-token-to-every-container-by-default).

## Related

- [Security report, H5](../2-26-10-27-security.md#h5-the-host-github-cli-token-is-injected-into-every-container-by-default-design-risk)
- [0220](#0220-stop-writing-the-github-token-into-the-containers-gitconfig): the same token in `~/.gitconfig`
- [0100](0100-m12-egress-sni-and-dns.md): other channels through the egress allowlist
- [Security report, §6 Informational](../2-26-10-27-security.md#6-informational) (I3)
