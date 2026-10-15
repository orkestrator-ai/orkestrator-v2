# GitHub CLI

Status: Living — `apps/backend/src/core/github-cli-binary.ts`,
`apps/backend/src/core/github-cli-setup.ts`,
`apps/web/src/components/github/GitHubCliSetup.tsx`.

PR detection, reviews, project creation from GitHub, the clone browser and
the host GitHub token all go through `gh`. Orkestrator ships its own copy and
can sign it in without the user leaving the app.

## Which `gh` runs

The toolchain pins `gh` as a support tool (`PINNED_SUPPORT_TOOL_VERSIONS` in
`packages/toolchain/src/manifest.ts`) and installs it with the agent CLIs on
macOS and Linux, arm64 and x64. How the pin is selected and bumped is in
[upgrade-agents.md](../development/upgrade-agents.md) § Support tools.

- **Backend calls.** At startup the backend resolves the managed binary once
  (`setManagedGitHubCli`) and every host-side call uses `gitHubCli()`: the
  token read (`getHostGitHubToken`), the PR monitor, reviews, project creation
  and the clone browser. Without a managed copy (Windows, or a failed
  toolchain download) it falls back to `gh` on `PATH`.
- **Terminals and agents** find the managed copy first on `PATH`.
- **Containers** use the image's distribution `gh`, which is not pinned.
- Every host copy shares gh's own configuration and stored login (Keychain or
  `~/.config/gh`), so signing in once covers all of them.

`check_github_cli` uses the same `checkHostTool` as the agent CLIs
(`host-tools.ts`): the managed copy first, then `PATH`. An agent-test profile
sees only its provisioned copy, never a host install on `PATH`.

## Status

`get_github_cli_status` returns:

| Field | Meaning |
| --- | --- |
| `installed` | `checkHostTool(context, "gh")` |
| `authenticated` | `gh auth token --hostname github.com` printed a token; always false when not installed |
| `canSignIn` | Installed, and the runtime is not an agent-test profile |
| `reminderDismissed` | The global `githubCliReminderDismissed` flag |

## Sign-in

`start_github_cli_login`, `get_github_cli_login` and `cancel_github_cli_login`
split the sign-in into start, poll and cancel, like agent account sign-in: it
waits on the user and must not hold a request open. One sign-in runs at a
time; a second start returns the pending one.

The backend runs `gh auth login --web --hostname github.com` through the agent
account login driver (`beginAgentAccountLogin`, kind `"github"`; see
[agent-accounts.md](agent-accounts.md) § Login). Without a terminal, `gh`
prints a one-time code and `https://github.com/login/device`, then exits once
the user approves. `parseGitHubDeviceLoginOutput` extracts both. The device
code lasts 15 minutes; the login is given 16.

- `GH_TOKEN` and `GITHUB_TOKEN` are removed from the login's environment.
  `gh` refuses to store a login while either is set, and a token the backend
  inherited is not the login being created.
- `open`/`xdg-open`, `BROWSER` and `GH_BROWSER` point at a no-op shim, so the
  renderer opens the page. That also works from a browser client on another
  machine.
- `gh` stores the token where it always does. The backend never reads the
  token during sign-in, and the CLI output is never logged.
- An agent-test profile isolates the host's GitHub configuration, so
  `startGitHubCliLogin` refuses to run there.

## Startup reminder

On startup the renderer reads the status. When `gh` is missing, or signed out
and `canSignIn`, and the reminder is not dismissed, it shows a non-blocking
dialog (`App.tsx`):

- **Sign In to GitHub** hosts `GitHubCliSetup`: the code with a copy button,
  **Open sign-in page**, and a waiting state until `gh` exits. The close
  button reads **Not Now** until sign-in succeeds, then **Done**.
- **GitHub CLI Not Found** (no managed copy and nothing on `PATH`) shows
  install commands, **Install instructions** and **Check again**.
- Closing the dialog dismisses it for the session. Ticking **Don't remind me
  again** first turns the reminder off for good, for both variants.

The opt-out is `githubCliReminderDismissed` in the global config, so it
applies to every window and browser client. Only
`set_github_cli_reminder_dismissed` writes it, through its own queued config
mutation. Every settings save carries the stored value forward, as it does for
`worktreeLocations`, so the settings form can neither clear nor overwrite it.

Settings → GitHub authentication shows the same `GitHubCliSetup` under **Use
host GitHub CLI credentials** while that switch is on. With the reminder
dismissed and `gh` signed out, it says so and offers **Remind me at startup**.
Missing-`gh` errors from project creation and the clone browser point there.

## Containers

**Use host GitHub CLI credentials** (`useHostGitHubCredentials`, on unless set
to false) decides where a container's GitHub token comes from: the host `gh`
login, or the stored personal access token (`githubToken`).
`get_container_github_credential_status` reports which source is in use and
whether it has a token. The in-app sign-in only ever writes the host `gh`
login.

## Tests

- `apps/backend/src/core/github-cli-setup.test.ts` — status, the login
  environment, the device flow, cancellation and the agent-test refusal.
- `apps/web/src/components/github/GitHubCliSetup.test.tsx` and
  `e2e/GitHubCliSetup.spec.ts` (fixture route `/github-cli-setup`).
- `RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 bun scripts/verify-toolchain-artifacts.ts
  --tool=gh` verifies the four pinned archives.
