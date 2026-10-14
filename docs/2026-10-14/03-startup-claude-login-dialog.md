# Startup "Claude Code Login Required" dialog blocks the whole app

Status: Active — found 2026-10-14, not fixed.

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
