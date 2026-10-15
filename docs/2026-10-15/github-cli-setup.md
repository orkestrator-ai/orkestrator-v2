# In-app GitHub CLI install and sign-in

Status: Implemented 2026-10-15 on `fix-startup-claude-login-dialog-blocks-app-6bc091684206`.

## What the user sees

- **Startup.** When `gh` is missing, the "GitHub CLI Not Found" dialog
  now includes the setup steps:
  - On macOS with Homebrew: an **Install with Homebrew** button.
  - Elsewhere: the install commands, **Install instructions** (opens
    cli.github.com) and **Check again**.
  - Once `gh` is installed: **Sign in to GitHub**. It shows GitHub's one-time
    code with a copy button and an **Open sign-in page** button, then waits for
    the user to approve.
  - The dialog stays open after an install so the user can sign in. Its button
    reads **Done** once `gh` is installed, and **Continue Without GitHub CLI**
    until then.
- **Settings → GitHub authentication.** With "Use host GitHub CLI
  credentials" on, the same setup appears under the switch. This covers a `gh`
  that is installed but signed out, which the startup dialog does not prompt
  for.

## How it works

- `apps/backend/src/core/github-cli-setup.ts` has the commands:
  - `get_github_cli_status` returns `{installed, authenticated,
    canInstallWithHomebrew}`. `authenticated` is `gh auth token` for
    github.com, the same check the container credential status uses.
  - `start_github_cli_install` and `get_github_cli_install` run `brew install
    gh` in the background with `NONINTERACTIVE=1`, a 10-minute cap and the
    last lines of output on failure. Homebrew's bin directory is already on the
    backend's PATH (`fix-path.ts`), so the new `gh` is used without a restart.
  - `start_github_cli_login`, `get_github_cli_login` and
    `cancel_github_cli_login` run `gh auth login --web --hostname github.com`.
    Without a terminal, gh prints the code and `https://github.com/login/device`
    and exits once the user approves.
- The sign-in reuses the agent-account login driver
  (`beginAgentAccountLogin`, kind `"github"`):
  - It gets a GitHub output parser.
  - It uses the same no-op `open`/`xdg-open` shim. The renderer opens the page,
    which also works from a browser client on another machine.
  - `GH_TOKEN` and `GITHUB_TOKEN` are removed from the login's environment.
  - gh stores the login where it always does; the backend never sees the
    token.
- Isolated `agent-test` profiles refuse install and sign-in, and never offer
  Homebrew, because both would write to the host.
- Renderer: `apps/web/src/components/github/GitHubCliSetup.tsx`, with API
  wrappers in `lib/backend/docker-skills.ts`.

## Not done: a managed `gh` download

The alternative was to ship `gh` the way Orkestrator ships the agent CLIs:
pinned, checksum-verified and installed into its own toolchain. That works
without Homebrew and on Linux, but it is a larger change:

- `PINNED_TOOLCHAIN_VERSIONS` defines `ToolchainName`.
  `selectPinnedToolchainArtifacts` requires every name for each platform, and
  `pinnedArtifactsForPlatforms` filters by agent platform. `gh` is not an agent
  platform.
- Each activated set gets its own bin directory, keyed by its contents. Adding
  `gh` at runtime yields a new directory that the running backend never sees
  until it restarts. Installs, leases and pruning also share one cache-wide
  transaction.
- Every `gh` call site runs `runCommand("gh", …)` against PATH. They would have
  to switch to a resolver that prefers a host `gh` (keeping its Keychain login)
  and falls back to the managed binary.

If Linux users without `gh` matter, do this next. The sign-in flow above works
unchanged with a managed binary.
