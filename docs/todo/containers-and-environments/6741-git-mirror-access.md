# Git mirror access: fetched with the backend's credential, readable by every container

## Task analysis

Analysed 2026-11-05 against `main` at `cbe0f9a5b`.

What E25 (DK-13, report part `0500`) left open about the per-project Git mirror: the report's "how a host-side mirror fetches a private repository a container's own credential can reach". The network half was built in E25; the credential half is this file. See [Project Git mirror](../../architecture/container-lifecycle.md#project-git-mirror).

### Tasks

1. **Fetch each mirror with the credential its readers hold**: a container reads through the mirror only what its own credential could fetch. Status: open.
2. **A credential that changes account under the same setting**: decide whether a mirror must notice. Status: open (depends on 1).

### 1. Fetch each mirror with the credential its readers hold

**Problem.** The backend fetches a project's mirror with its own credential, and every container of the project can read the mirror. A container that holds no credential for a private repository can therefore read every branch of it at `/orkestrator-git-mirror`.

**Context.** Containers receive a GitHub token only when Settings chooses one: `containerGitHubCredential` defaults to `none` (`containerGitHubCredentialSource` in `apps/backend/src/core/github-credentials.ts`). The mirror's fetch (`fetchInto` in `apps/backend/src/core/project-git-mirror.ts`) uses `gitHubGitCredentials`, which is the backend's own GitHub source (the host's `gh auth login` by default, or the stored PAT), and for any other remote the host's own Git configuration, credential helpers and SSH keys through `runRemoteGit`. A container's clone uses only the GitHub token it was given, over HTTPS (`convert_ssh_to_https` in `docker/workspace-setup.sh`), and nothing for other hosts. The clone from the mirror still contacts the remote for its refs, so it fails without a credential; the mount stays readable whatever the clone did. `docs/architecture/container-lifecycle.md` records the exposure ("Every environment of a project can read every branch of it through the mount, whatever credential that environment holds"). The environment exists to work on that repository, which limits the harm, but a user who withholds GitHub credentials from containers would not expect the agent to read the repository anyway.

E25 built the network half: a restricted container whose firewall would not reach the remote gets no mount (`restrictedContainerReachesGitRemote`, `git-mirror.mount-withheld`).

**Investigation.** A single mirror per project cannot serve readers with different credentials, because its mount directory is bound when a container is created and a later rebuild is visible through it. So a fix needs one mount directory per kind of access, and a container must be bound only to the directory of the access it holds. Not built in E25: it reworks the mirror's layout, its refresh and most of `apps/backend/tests/project-git-mirror.integration.test.ts`, which redirects remotes through the global Git configuration that an isolated fetch would ignore, and it was outside the time the batch had.

**Decisions.**

- **How should a mirror be fetched?**
  - **With exactly what the containers are given, per access kind (recommended).** Resolve the access at container creation and at refresh: `github-pat` or `github-host-cli` when `resolveContainerGitHubToken` returns a token for a GitHub remote, otherwise `anonymous`. Keep one mount per kind (`<project>/mount-<kind>/mirror.git`), bind a container only to its own kind's directory, record the kind in `state.json`, and rebuild when it changes; a refresh retires the other kinds' mirrors (not their directories, which stopped containers still name with `-v`), and the legacy `mount/mirror.git` on the first refresh. Fetch with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, `GIT_ALLOW_PROTOCOL` limited to what the container itself would use, the URL converted as `convert_ssh_to_https` does, and, for a token, `gitHubGitCredentials`' helper fed that token rather than the backend's.
    - Pros: the mirror can never hold more than its readers' own credential fetches; public repositories keep the mirror under the default `none`; the bound per project stays one live mirror.
    - Cons: the work above; a private repository under `none` gets no mirror, which is correct because its clone fails anyway; host Git settings such as `http.proxy` no longer apply to the fetch (proxy variables still do).
  - **Mount only when the container's GitHub source is the backend's.**
    - Pros: a small change at creation.
    - Cons: no mirror at all under the default `none`, even for public repositories, and none for remotes off GitHub.
  - **Leave it, as documented.**
    - Pros: nothing to build; the content is the project the environment was made for.
    - Cons: the exposure above stays.

### 2. A credential that changes account under the same setting

**Problem.** With task 1 built, a mirror fetched with one GitHub account stays readable after the same setting starts handing containers a different account's token (another `gh auth login`, or a new PAT).

**Context.** The access kind would record the source, not the account. A token fingerprint in `state.json` would notice the change, but `state.json` sits beside the mount and is owner-only; even a hash of a token is credential-derived data.

**Investigation.** Not built or measured.

**Decisions.**

- **Does the mirror need to notice?**
  - **Rebuild when the token's account login changes, read from `gh api user` at refresh (recommended).**
    - Pros: no credential-derived value stored; the login is not secret.
    - Cons: one more GitHub request per refresh, and the read can fail.
  - **Store a keyed hash of the token.**
    - Pros: no request.
    - Cons: credential-derived data on disk, and a key to keep.

## Related

- [6740 input staging follow-ups](6740-input-staging-follow-ups.md).
- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), task 15.
- [0018 container network and credential isolation](0018-container-network-and-credential-isolation.md).
