# In-app GitHub CLI install and sign-in

Status: Implemented 2026-10-15 on `fix-startup-claude-login-dialog-blocks-app-6bc091684206`.

## What the user sees

- **No install step.** Orkestrator downloads its own pinned, checksum-verified
  `gh` (2.102.0) with the agent CLIs, so `gh` is available without Homebrew,
  apt or winget.
- **Startup.** When `gh` is signed out, a dismissible "Sign In to GitHub"
  dialog offers **Sign in to GitHub**:
  - It shows GitHub's one-time code with a copy button, an **Open sign-in
    page** button and "Waiting for you to approve the sign-in…".
  - Once you approve, the dialog shows the signed-in state and its button
    reads **Done**. Before that it reads **Not Now**.
  - Dismissing it lasts for the session, like the other startup notices.
  - Ticking **Don't remind me again** before closing turns the reminder off
    for good, for both the sign-in and the missing-`gh` dialog. The choice is
    stored in the global config (`githubCliReminderDismissed`), so it applies
    to every window and browser client. Settings → GitHub authentication then
    says so and offers **Remind me at startup** to turn it back on.
- **No `gh` at all.** This is rare: Windows, or a failed toolchain download.
  The old "GitHub CLI Not Found" dialog appears with install commands, an
  **Install instructions** link and **Check again**.
- **Settings → GitHub authentication.** With "Use host GitHub CLI
  credentials" on, the same setup appears under the switch.
- **Isolated `agent-test` profiles** are never offered sign-in. They isolate
  the host's GitHub configuration, and the backend refuses to write a login
  there.

## How it works

- **Toolchain** (`packages/toolchain/src/manifest.ts`):
  - `PINNED_SUPPORT_TOOL_VERSIONS = { gh }` sits beside the agents'
    `PINNED_TOOLCHAIN_VERSIONS`. `ToolchainName` covers both, and
    `PINNED_TOOL_VERSIONS` merges them.
  - There are four `ghArtifact(...)` entries: the macOS zip and Linux tar.gz
    for arm64 and x64. They come from `cli/cli` releases, and the digests were
    checked against the release's checksums file.
  - The macOS binary is signed and notarized by GitHub and installs unmodified.
  - `pinnedArtifactsForPlatforms` adds support tools to every non-empty
    selection; an empty selection still downloads nothing. The headless
    installer (`install.ts`) adds them to every selection, and dev profiles
    seed them too.
  - The Docker image keeps its distribution `gh`. The drift test asserts that
    `gh` is not treated as an agent.
- **Backend:**
  - `github-cli-binary.ts` resolves the managed `gh` once at startup, falling
    back to `gh` on `PATH`. Every host-side call uses it: the token read, PR
    monitor, reviews, project creation, the clone browser and local
    environment runners. Orkestrator's terminals and agents already find the
    managed copy first on `PATH`, and all copies share gh's configuration and
    login.
  - `check_github_cli` uses the same `checkHostTool` as the agents (moved to
    `host-tools.ts`). Agent-test profiles therefore see only their provisioned
    copy.
  - `set_github_cli_reminder_dismissed` writes the reminder flag through its
    own queued config mutation. Like `worktreeLocations`, every settings save
    carries the stored value forward, so the settings form can neither clear
    nor overwrite it.
  - `github-cli-setup.ts` provides:
    - `get_github_cli_status`, returning `{installed, authenticated,
      canSignIn, reminderDismissed}`;
    - start, poll and cancel commands for `gh auth login --web --hostname
      github.com`, through the agent-account login driver (kind `"github"`).
    The sign-in removes `GH_TOKEN` and `GITHUB_TOKEN` from the login's
    environment, uses a no-op browser shim so the renderer opens the page, and
    never sees the token.
- **Renderer:** `components/github/GitHubCliSetup.tsx`, used by the startup
  dialog in `App.tsx` and by `GlobalSettings.sections.tsx`.
- **Messages:** the missing-`gh` errors in project creation and the clone
  browser now point at Settings → GitHub authentication.

## Verified

- The real toolchain manager installed the pinned `gh` into a scratch data
  directory on macOS arm64. Download, digests, code signature, `--version`
  probe and activation all passed in about a second.
- `RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 bun scripts/verify-toolchain-artifacts.ts
  --tool=gh` verified all four artifacts.
- The backend sign-in, run against the real `gh` with a scratch config,
  returned `https://github.com/login/device` and a code, and cancelled cleanly.
