# Local start: git remote failures

A local-worktree environment's start fetches the base branch from the
project checkout's `origin` (`resolveRemoteWorktreeStartPoint`) before it
creates the worktree. When that fetch cannot reach the remote, the start
fails with a message that names the cause, the message stays on the
environment, and, when the backend has checked that it would work, the
environment offers to switch the project to HTTPS.

## What the user sees

The failure is persisted as the environment's `lifecycleError`, a sanitized
message chosen by `environmentLifecycleErrorMessage`
(`apps/backend/src/core/commands-error-text.ts`). Git remote failures have
their own wording:

| Cause | Message |
| --- | --- |
| OpenSSH could not connect (`ssh: connect to host <host> port <port>: Operation timed out`, `Connection timed out`, `Connection refused`, `Network is unreachable`, `No route to host`) | "Couldn't reach the git remote over SSH (`<host>`, port `<port>`). Your network may be blocking SSH. …" |
| OpenSSH refused every key (`Permission denied (publickey)`) | The SSH authentication message (load a key in an agent). |
| The fetch outlived Orkestrator's 120 s deadline | The remote timeout message. On Linux an SSH connect to a dropped port usually lands here, because the kernel's connect timeout is longer than the deadline. |

The SSH connect message carries only the host and port, which
`sshConnectFailure` (`git-ssh-transport.ts`) restricts to hostname
characters and a number; no path, URL or other child output is persisted.
A failed start rethrows these messages as-is, so the immediate error and the
persisted one agree.

The renderer shows `lifecycleError` in the "Environment not started"
overlay (`StartFailureNotice`), not only in a toast. It is read from the
environment record, so it survives switching away, reloading and restarting
until the next start clears it.

The log line (`[environment] lifecycle.failed`) classifies both SSH
connect wordings as `reason=network-failed`.

## The HTTPS remedy

After a local start fails with the SSH connect message or the remote
timeout, `startFailureRemedy` (`environment-start-remedy.ts`) checks whether
HTTPS would work, and records `lifecycleRemedy: "use-https"` only when:

- the checkout's raw `remote.origin.url` is a GitHub SSH remote
  (`git@github.com:owner/repo(.git)` or `ssh://[git@]github.com[:22]/owner/repo`);
- Git has a credential helper for `https://github.com`
  (`git config --get-urlmatch credential.helper`); a credential is never read; and
- `git ls-remote <https-url> HEAD` succeeds non-interactively within 20 s.

The overlay then offers **Use HTTPS for this project**. It calls
`use_https_git_remote` (projects domain), which repeats the check, runs
`git remote set-url origin https://github.com/<owner>/<repo>.git` in the
project checkout and answers `{ remoteUrl, changed }`; the renderer then
starts the environment again. Worktrees share the repository's config, so
every local environment of the project follows.

The project's stored `gitUrl` is not changed: it is the project's identity,
and containers already convert an SSH remote to HTTPS before cloning
(`convert_ssh_to_https` in `docker/workspace-setup.sh`).

`lifecycleRemedy` belongs to the failure it was checked against: storage
clears it (to an explicit `null`) on any write of `lifecycleError` that does
not carry a remedy of its own, so a retry or a different failure never
inherits it.
