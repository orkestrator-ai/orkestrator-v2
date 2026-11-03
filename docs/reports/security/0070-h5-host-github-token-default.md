# Stop handing the host GitHub token to every container by default

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Choose the default credential for containers**: host-token sharing is on unless the user turns it off. Status: open.
2. **Separate the container credential from the backend's own**: one setting drives both today. Status: open (depends on 1).
3. **Warn about scope**: the setting does not say what the token can reach. Status: open.

### 1. Choose the default credential for containers

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

### 2. Separate the container credential from the backend's own

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

### 3. Warn about scope

**Problem.** The Settings text only says that the toggle reuses the account from `gh auth login` (`apps/web/src/components/settings/GlobalSettings.sections.tsx:725-734`).

**Context.** The report asks for a scope warning alongside the opt-in.

**Investigation.** No warning text was found in that section.

**Decisions.** None: the wording follows whichever option task 1 takes.

## Constraints and rationale

- `useHostClaudeCredentials` already follows the rule that a long-lived host token should not be read at all once it is off (`apps/backend/src/core/commands-files.ts:2510-2520`). Keep to the same rule here.

## Needs verification

- Which scopes a typical `gh auth token` carries on the users' hosts: the report's list is typical, and nothing here measures it.

## Related

- [Security report, H5](../2-26-10-27-security.md#h5-the-host-github-cli-token-is-injected-into-every-container-by-default-design-risk)
- [0220](0220-i3-github-token-in-gitconfig.md): the same token in `~/.gitconfig`
- [0100](0100-m12-egress-sni-and-dns.md): other channels through the egress allowlist
