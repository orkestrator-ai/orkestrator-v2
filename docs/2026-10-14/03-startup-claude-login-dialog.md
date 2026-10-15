# Startup "Claude Code Login Required" dialog blocks the whole app

Status: Fixed 2026-10-15 on `fix-startup-claude-login-dialog-blocks-app-6bc091684206`
(see [Resolution](#resolution)). Line references below are as found.

**Severity: high for users without OpenCode installed; it also breaks
`mise run test:agent:browser:isolated` on such hosts.**

## Symptom

At startup the renderer shows a modal "Claude Code Login Required" dialog with
only **Retry** and **Close Application**. Nothing behind it can be used.

It appears whenever all of these hold:

- the `claude` executable is found (managed toolchain **or host `PATH`**);
- `~/.claude.json` is not found (or, in an agent-test profile, the `claude`
  credential source is not enabled);
- no `opencode` executable is found.

Codex, Cursor, Grok and Pi availability are ignored, so a user who works only
with Codex is locked out if they also have an unauthenticated `claude` on
`PATH`.

## Where

- Condition: `apps/web/src/App.tsx:916-921`

  ```ts
  const claudeNeedsLogin =
    hostToolWarningsVisible &&
    hostToolCheckStatus === "complete" &&
    claudeCliAvailable === true &&
    claudeConfigAvailable === false &&
    opencodeCliAvailable === false;
  ```

  The comment above the dialog (`App.tsx:1526`) still describes the
  two-platform era: "only shows when Claude is available but not logged in, and
  OpenCode is NOT available as fallback".
- Dialog: `App.tsx:1527-1557`.
- Inputs: `apps/backend/src/core/commands-registry-tools.ts`:
  - `check_claude_cli` and `check_opencode_cli` use `checkHostTool`
    (`:42-50`). It accepts a managed binary **and falls back to the host
    `PATH`**, even in an isolated `agent-test` profile.
  - `check_claude_config` (`:117-121`) **is** isolation-aware. It returns
    `false` in an agent-test profile unless the `claude` credential source is
    enabled.

## Effect on the isolated browser suite

`test:agent:browser:isolated` starts its profile with
`--no-agent-credentials --agent-platforms codex`. On this host (`claude` at
`~/.local/bin/claude`, no `opencode` on `PATH`) the profile therefore sees
"Claude installed (via host PATH), not configured (isolated), no OpenCode".
Every spec that waits for the project list times out behind the dialog.

Evidence from 2026-10-14:

- The branch run: 11 failures, then the 15-minute cap.
- The unmodified base commit `d4dfa11d` with the same flags shows the same
  dialog (`agent-accounts.spec.ts` fails identically).
- Adding `--credential-source claude` did **not** clear it. Either
  `~/.claude.json` is not visible to the isolated backend, or the import
  covers only the credential file. Not confirmed.
- Provisioning OpenCode (`--agent-platforms codex,opencode,cursor,grok`)
  clears it. That suite then ran 17 passed, 12 skipped and 5 failed; the
  failures are described in `05-real-stack-suite-host-dependencies.md`.

## Fix

1. Make the gate platform-neutral: only block when **no** usable agent
   platform exists. Better still, never block: show a dismissible notice that
   Claude needs a login while other platforms keep working. The existing
   `noAiCliAvailable` check (`App.tsx:907-913`) has the same two-era shape and
   also ignores Cursor, Grok and Pi.
2. In `agent-test` profiles, `checkHostTool` should not fall back to the host
   `PATH` for platforms the profile did not provision. Today it leaks host state
   into an isolated profile, while `check_claude_config` deliberately does not.
3. Work out why `--credential-source claude` still reports "not configured",
   and make the isolated runner's profile flags produce a usable app on a
   machine with `claude` on `PATH`.
4. Tests: a renderer test for the gate covering Codex-only, Cursor-only and
   Claude-unauthenticated-with-Codex, and a backend test that `checkHostTool`
   ignores host `PATH` in agent-test profiles.

## Resolution

Fixed on 2026-10-15.

- **Gate.** The login dialog no longer blocks. It is now a dismissible
  "Claude Code Is Not Logged In" notice with **Retry** and **Continue Without
  Claude**, shown whenever Claude is installed but has no login, whatever else
  is installed. `noAiCliAvailable` now relies only on the backend's
  `get_available_ai_cli`, which already covers all six platforms. The
  renderer's own OpenCode and Codex probes fed only the old two-platform
  conditions, so they and their helpers are gone. The GitHub CLI warning now
  follows any available platform, not just Claude or OpenCode, and waits until
  the Claude notice is dismissed so the two modals do not stack.
- **Host `PATH` in agent-test.** `checkHostTool` reports only managed
  binaries in an `agent-test` profile. A profile provisions its platforms into
  its toolchain, so anything found only on the host `PATH` is a platform it did
  not provision. This covers `check_claude_cli`, `check_opencode_cli`,
  `check_codex_cli`, `check_pi_cli`, `check_any_ai_cli` and
  `get_available_ai_cli`.
- **`--credential-source claude` read as "not configured".** Confirmed cause:
  an agent-test backend runs with `HOME` set to the profile's isolated home
  (`backend-process.ts`, `createBackendProcessEnvironment`). `homePath(".claude.json")`
  therefore pointed at the empty isolated home. Nothing copies `~/.claude.json`
  there; Claude launches are instead pointed at the host through
  `ORKESTRATOR_AGENT_TEST_HOST_HOME` and
  `ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR`. `check_claude_config` and
  `has_claude_credentials` now look in the same host locations when the
  `claude` source is enabled: `$CLAUDE_CONFIG_DIR/.claude.json` and
  `<host home>/.claude.json`.
- **Tests.** `App.test.tsx` covers Codex-only and Cursor-only hosts (no gate),
  an unauthenticated Claude that is dismissed and leaves the app usable, and
  the GitHub warning waiting for the Claude notice.
  `apps/backend/tests/commands-registry-tools.test.ts` covers: host `PATH`
  installs ignored in agent-test, still accepted in development, managed
  binaries still reported, and the host Claude login read when the `claude`
  source is allowed and ignored when it is not. Both backend tests fail on the
  previous code.
- **Isolated browser suite.** With the default flags (`--agent-platforms
  codex`) on this host, the profile logs `tool=claude available=false
  source=missing` and `tool=codex source=managed`. No startup dialog appears.
  The run finished in 8.0 minutes with 15 passed, 12 skipped and 7 failed,
  where before it had 11 failures and then hit the 15-minute cap. None of the 7
  failure contexts shows a startup dialog. The failures are the worktree-path
  assumption from 05 (`browser-gateway.spec.ts:500` and `:1725`),
  `browser-gateway.spec.ts:147` (narrow host picker; the button is not
  visible), `:386` (Home unread state), `cli-ui.spec.ts:169` (`project list`
  printed no envelope) and `native-draft-attachments.spec.ts:104` for Cursor
  and Grok, which this codex-only profile does not provision. They belong to
  05.

### Left open

- Spawning still falls back to `PATH` in agent-test (`resolveClaudeBinary`,
  `resolveOpenCodeBinary` and similar in `commands-agent-support.ts`).
  Availability is now reported correctly, so the app no longer offers those
  platforms. A launch requested directly through the backend could still reach
  a host binary.
- When the host has no `CLAUDE_CONFIG_DIR`,
  `ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR` defaults to `~/.claude`.
  Claude launched with that `CLAUDE_CONFIG_DIR` looks for
  `~/.claude/.claude.json`, not `~/.claude.json`, so it may treat the profile
  as a first run. Auth still works through `ANTHROPIC_AUTH_TOKEN`. Not
  verified live.
- The GitHub CLI warning now covers Codex-only, Cursor-only, Grok-only and
  Pi-only users. Before, it showed only when Claude or OpenCode was found. On a
  host without `gh`, a codex-only isolated profile will therefore show that
  (dismissible) warning, and only `browser-gateway.spec.ts:1023` dismisses it.
  This host has `gh`, so the run above was unaffected.
  Superseded: Orkestrator now installs its own `gh` with the toolchain, so
  isolated profiles have one and are never offered GitHub sign-in. See
  [`../2026-10-15/github-cli-setup.md`](../2026-10-15/github-cli-setup.md).
