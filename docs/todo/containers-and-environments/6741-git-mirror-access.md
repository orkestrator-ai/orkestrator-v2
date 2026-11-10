# Git mirror access: fetched with the backend's credential, readable by every container

## Task analysis

Analysed 2026-11-05 against `main` at `cbe0f9a5b`; tasks 1 and 2 built and task 3 added 2026-11-10 against `main` at `c6de4733c`.

What E25 (DK-13, report part `0500`) left open about the per-project Git mirror: the report's "how a host-side mirror fetches a private repository a container's own credential can reach". The network half was built in E25; the credential half is this file. The durable behaviour is described in [Project Git mirror](../../architecture/container-lifecycle.md#project-git-mirror).

### Tasks

1. **Fetch each mirror with the credential its readers hold**: a container reads through the mirror only what its own credential could fetch. Status: done (2026-11-10).
2. **A credential that changes account under the same setting**: decide whether a mirror must notice. Status: done (2026-11-10).
3. **Qualify the credential paths against real GitHub**: a real token, a real `gh api user` read and a real private repository. Status: open (needs a real GitHub login; not allowed on the node that built 1 and 2).

### 1. Fetch each mirror with the credential its readers hold

**Problem.** The backend fetched a project's mirror with its own credential, and every container of the project could read the mirror. A container that held no credential for a private repository could therefore read every branch of it at `/orkestrator-git-mirror`.

**Context.** Containers receive a GitHub token only when Settings chooses one: `containerGitHubCredential` defaults to `none` (`containerGitHubCredentialSource` in `apps/backend/src/core/github-credentials.ts`). The mirror's fetch used `gitHubGitCredentials`, the backend's own GitHub source, and for any other remote the host's own Git configuration, credential helpers and SSH keys through `runRemoteGit`. A container's clone uses only the GitHub token it was given, over HTTPS (`convert_ssh_to_https` in `docker/workspace-setup.sh`), and nothing for other hosts.

E25 built the network half: a restricted container whose firewall would not reach the remote gets no mount (`restrictedContainerReachesGitRemote`, `git-mirror.mount-withheld`).

**Investigation.** A single mirror per project cannot serve readers with different credentials, because its mount directory is bound when a container is created and a later rebuild is visible through it. Built 2026-11-10 (commits `ce971385e`, `6953d2b3d`): `apps/backend/src/core/project-git-mirror-access.ts` resolves the access a container is given (`resolveGitMirrorAccess`: `github-pat`, `github-host-cli` or `anonymous`) and builds an isolated fetch (container URL, `GIT_ALLOW_PROTOCOL` limited to its scheme, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, an empty `HOME` per fetch, no backend `GIT_*`/`GH_TOKEN`/`GITHUB_TOKEN`/`SSH_ASKPASS`, the `https://github.com` helper fed the container's token). `project-git-mirror.ts` binds `mount-anonymous/` or a fresh `mount-<kind>-<uuid>/` per authenticated container, retires the other kinds' and the legacy mirror on every refresh, records the kind in `state.json`, cancels an in-flight refresh when the access changes, and probes the remote before seeding from the host checkout. Evidence: `apps/backend/tests/project-git-mirror.integration.test.ts` shows the host's credential helper, `.netrc` and askpass each let plain Git read a private smart-HTTP remote (`apps/backend/tests/git-http-fixture.ts`) while the mirror fetch is refused; `project-git-mirror-access.test.ts` and `project-git-mirror-create.test.ts` cover resolution and which mount a container gets; `project-git-mirror-docker.test.ts` passed 4/4 with live Docker on beelink.

**Decisions.**

- **How should a mirror be fetched?**
  - **With exactly what the containers are given, per access kind (recommended; built).**
    - Pros: the mirror can never hold more than its readers' own credential fetches; public repositories keep the mirror under the default `none`; one live mirror per project.
    - Cons: a private repository under `none` gets no mirror, which is correct because its clone fails anyway; host Git settings such as `http.proxy` no longer apply to the fetch (proxy variables still do).
  - **Mount only when the container's GitHub source is the backend's.**
    - Pros: a small change at creation.
    - Cons: no mirror at all under the default `none`, even for public repositories, and none for remotes off GitHub.
  - **Leave it, as documented.**
    - Pros: nothing to build.
    - Cons: the exposure above stays.

### 2. A credential that changes account under the same setting

**Problem.** With task 1 built, a mirror fetched with one GitHub account would stay readable after the same setting starts handing containers a different account's token (another `gh auth login`, or a new PAT).

**Context.** The access kind records the source, not the account. A token fingerprint in `state.json` would notice the change, but even a hash of a token is credential-derived data.

**Investigation.** Built 2026-11-10: each refresh with a token reads its login with `gh api user` (`getGitHubTokenLogin` in `github-credentials.ts`, token passed through the environment) and stores the lower-cased login in `state.json`. A different login withdraws the mirror and rebuilds at once; an unreadable login withdraws it and waits for the normal interval; an unknown identity never publishes. Because every authenticated container also gets its own fresh bind generation, a reader can never see a mirror fetched with another account's or another token's access. Covered with a fake `gh` in `project-git-mirror-access.test.ts` and the account-change cases in `project-git-mirror.integration.test.ts`.

**Decisions.**

- **Does the mirror need to notice?**
  - **Rebuild when the token's account login changes, read from `gh api user` at refresh (recommended; built).**
    - Pros: no credential-derived value stored; the login is not secret.
    - Cons: one more GitHub request per refresh, and the read can fail.
  - **Store a keyed hash of the token.**
    - Pros: no request.
    - Cons: credential-derived data on disk, and a key to keep.

### 3. Qualify the credential paths against real GitHub

**Problem.** Tasks 1 and 2 are proven only against local fixtures: a smart-HTTP Git server standing in for a private remote and a fake `gh` standing in for `gh api user`. Nothing has yet shown that the isolated fetch authenticates to real `https://github.com` with a real token, or that a real `gh api user` returns the login the code expects.

**Context.** The build pipeline that built tasks 1 and 2 ran on beelink under a brief that forbade real logins and billed or credentialed external requests, so a real GitHub account was not available. The behaviour that depends on GitHub itself: the `https://github.com` credential helper fed the token by environment (`gitHubTokenCredentialOptions`), `gh api user` with `GH_TOKEN` set, and an anonymous fetch of a private repository failing without a prompt.

**Investigation.** Not run. What it needs, on an isolated `dev:test` profile with a container fixture and a real GitHub account that owns a private test repository:

1. With `containerGitHubCredential` `none`, create a container environment of the private repository: confirm its refresh is refused by the remote probe, nothing is seeded from the host checkout, and no `mirror.git` appears under `mount-anonymous/`.
2. Switch the setting to a PAT (`github-pat`) and create an environment: confirm it is bound to a new, empty `mount-github-pat-<uuid>/`, its refresh publishes `mirror.git` there, and `state.json` records the account's login (and no token).
3. Switch to a PAT of a second account and create an environment: confirm `git-mirror.access-changed` is logged, the first account's generation no longer holds a mirror, and `state.json` holds the new login.
4. Repeat 2 with `github-host-cli` on a host signed in with `gh auth login`.
5. With a public repository under `none`, confirm the mirror is built under `mount-anonymous/` and the next environment's clone logs `git-mirror.clone-used`.

**Decisions.**

- **Where should the qualification run?**
  - **A maintainer's machine with a disposable GitHub account and private repository (recommended).**
    - Pros: exercises the real token paths; no shared credential.
    - Cons: needs a person to sign in and to create the account and repository.
  - **Leave it to the local fixtures.**
    - Pros: nothing more to do; the fixtures cover the isolation logic.
    - Cons: a GitHub-side difference (helper protocol, `gh api user` output, prompt on refusal) would go unseen until a user hit it.

## Current state

Tasks 1 and 2 are built and covered by tests; the architecture page describes the behaviour. Task 3, the real-GitHub qualification, is open.

## Assumptions and decisions

### Task 1: authenticated readers get a fresh bind generation (2026-11-10)

Chose a random `mount-<kind>-<uuid>` directory per authenticated container instead of one reusable `mount-<kind>/` per kind. A Docker bind lasts for the container's lifetime, so a reused per-kind directory would let a container see a mirror later fetched with another account's or another token's access, and review rejected it. Cost: an authenticated container never starts from an already-populated mirror, and retained empty generation directories accumulate until the project is deleted.

### Task 1: `file` allowed only for the agent-test fixture (2026-11-10)

The mirror fetch allows the `file` protocol only when the remote is the verified agent-test fixture the container itself reaches through its own bind (`localRemote`); any other local path or `file://` remote gets no mirror, because a container's clone of it would use only HTTP(S). The old git:// seed test was rewritten to use the smart-HTTP fixture.

### Task 2: an unreadable login waits for the interval (2026-11-10)

An unreadable login withdraws the mirror and records `null` without bypassing the 15-minute refresh interval, so a host without `gh` cannot trigger a full rebuild on every container creation.

### Task 3: left open (2026-11-10)

The building pipeline's brief forbade real logins, so the real-GitHub qualification was not attempted and no evidence for it is claimed.

## Related

- [6740 input staging follow-ups](6740-input-staging-follow-ups.md).
- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), task 15.
- [0018 container network and credential isolation](0018-container-network-and-credential-isolation.md).
