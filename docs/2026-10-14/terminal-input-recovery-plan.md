# Terminal input recovery: one strict rule plus an explicit resume

Status: Implemented (2026-10-15) on `feat-terminal-input-resume-strict-fence`.
Format, lint and typecheck pass, as do the protocol, web, desktop, web-public,
CLI and toolchain test suites. The only full-suite failures are unrelated and
also fail on main: host-dependency tests (firewall, `migrate-copy`, the Pi
vendoring timeout) and one backend shutdown test. The real-browser, Electron
and inactive-environment checks under Verification are automated as agent
specs and pass.
Depends on: the shared transport core (#968), which introduced
`TerminalInputSequencer` and the transport contract fixtures. It is on main;
this is a separate, deliberately behaviour-changing PR.

## Problem

After the shared-core refactor, the browser gateway and the desktop client run
the same terminal input queue. The one remaining difference is what makes input
work again after a write's outcome was lost (timeout, dropped response, network
error, in-band refusal). It is a single option today,
`TerminalInputRecovery` in
[`terminal-input-sequencer.ts`](../../packages/protocol/src/terminal-input-sequencer.ts):

| Event after a failed write | Browser (`rearm-on-lifecycle`) | Desktop (`fence-until-start`) |
| --- | --- | --- |
| Successful resize | Re-arms input | Stays fenced |
| A write the WebSocket accepts | Re-arms input | n/a (no socket) |
| Resize fails | Unchanged | Fences input |
| Close fails | Terminal stays writable | Stays closed |
| Start fails | Terminal stays writable | Fenced with the start error |
| Successful start | Re-arms | Re-arms |

Neither rule is right on its own:

- **The browser rule re-arms on an accident.** Resizes fire from layout
  changes (fit on window, pane or tab changes), not from anyone deciding input
  is safe again. Its premise, that the terminal's echo shows what reached the
  shell, holds at a prompt but not in full-screen programs (vim, `less`, a
  Claude session in tmux), where a half-delivered prefix plus later keystrokes
  can act without ever being displayed. That is the "dangerous prefix" case
  #944 was written for.
- **The desktop rule's only recovery is destructive.** The input-failure toast
  offers "Reconnect", and for a renderer-owned terminal that runs
  `detach_terminal` / `close_local_terminal_session`, which reach
  `explicitlyCloseTerminalSession`: the PTY is killed and its history disposed.
  One lost response on a flaky remote link therefore costs the shell and
  everything running in it.

## Target behavior

One rule on every client: **fence until start, plus an explicit,
non-destructive resume.**

1. Nothing re-arms a failed terminal automatically. Resize, a socket-accepted
   write, or a failed lifecycle command never re-enables input.
2. A successful start re-arms, as today.
3. The user can re-arm explicitly from the failure toast with **Resume input**,
   after looking at the terminal. The shell and its processes survive.
4. Resume clears only a failure fence. It never reopens a terminal whose close
   was requested; only a start does that.
5. "Reconnect" stays as the second toast action for when the terminal really
   is broken.
6. `TerminalInputRecovery` is removed; there is no per-client policy left.

Failed close and failed start keep the strict outcomes above. A failed close
almost always belongs to a terminal the UI is tearing down, and after a failed
start the shell may not exist, so Resume there just reaches the backend's
in-band refusal and fences again. That is harmless and needs no special case.

## Design

### Shared core (`packages/protocol`)

- `TerminalInputSequencer`:
  - Remove `recovery`, `TerminalInputRecovery`, and the `rearms` branches. Keep
    today's `fence-until-start` behaviour throughout, including the pipelined
    path (a latched failure vetoes socket writes; an accepted socket write does
    not clear it).
  - Add a client-side command, `terminal_input_resume`
    (`{ sessionId, local?: boolean }`, or one command per family,
    `terminal_input_resume` / `local_terminal_input_resume`, mirroring the
    write commands). `invoke` answers it locally and **never sends it to the
    backend**: it calls `batcher.clearFailure` for that terminal and resolves
    `{ resumed: boolean }` (false when nothing was fenced). It must not touch
    the closed-session set.
  - Order resume like a lifecycle command: queue it behind the terminal's
    lifecycle tail, so a resume issued after a close or start cannot jump
    ahead of it.
- Export the command name(s) as constants so the renderer and both clients
  share one spelling.
- Because the sequencer answers the command, both clients get it with no
  adapter code. The browser gateway intercepts in `api.invoke`; the desktop
  renderer's `invoke` crosses IPC to `BackendHttpClient.invoke` in the main
  process, which already routes through the sequencer.

### Renderer

- `apps/web/src/lib/backend/terminals.ts`: add `resumeTerminalInput(sessionId,
  { local })`. Treat an `Unknown backend command` rejection as `false`, so a
  renderer that somehow reaches a client without the intercept degrades to the
  old behaviour instead of throwing.
- `apps/web/src/hooks/useTerminal.ts`, `reportInputFailure`:
  - When there is a session id and the shell is not known to be gone, the
    toast's primary `action` becomes **Resume input**. It calls
    `resumeTerminalInput` for the right family (`isLocalRef`) and dismisses
    the toast on success. Sonner's `cancel` button carries **Reconnect**.
  - Keep Reconnect as the only action for "not connected to a running shell"
    (no session id) and for the in-band "no longer running" refusal.
  - Keep the toast id keyed by session, so repeated failures still collapse
    into one toast.
  - Update the comment above `reconnect`: Resume is the non-destructive path;
    Reconnect restarts the shell.
- Copy (sentence case, matching the existing toast): title "Terminal input
  failed"; description is the failure message plus "Check the terminal before
  resuming: part of your last input may have reached the shell."

## Tests

### Contract (`terminal-input-contract-fixtures.ts`)

- Collapse the three `recovery:` scenarios to single expectations:
  - Successful resize after a failed write: input stays rejected.
  - Close that never landed: the terminal stays closed.
  - Failed start: input is rejected with the start error.
- Add:
  - Resume after a failed write re-arms, and the next write is delivered.
  - Resume does not reopen a closed terminal.
  - Resume on a healthy terminal resolves `{ resumed: false }` and sends
    nothing.
  - Resume issued after a close waits for that close and leaves the terminal
    closed.
  - Resume never reaches the backend (the wire log stays empty).
- Remove `recovery` from `TerminalContractAdapter`.

### Unit (`terminal-input-sequencer.test.ts`)

- Drop the per-recovery parameterisation of the pipelined test; assert the
  strict outcome.
- Resume re-arms a fence created by a failed pipelined path, and a later
  accepted socket write is delivered.

### Browser gateway (`apps/web/src/lib/native/web-gateway.test.ts`)

These pin the old browser rule and must change:

| Current test | New expectation |
| --- | --- |
| re-arms a terminal whose input failed once the transport recovers | Stays fenced after the resize; re-arms after resume |
| keeps a live terminal writable when its close never reached the backend | Stays closed; writable after a start |
| reopens a terminal whose start command failed | Fenced with the start error; a successful retry re-arms |
| keeps socket input working after a transient HTTP write failure latched the queue | Socket write rejected until resume |

"leaves a failed queue closed when the recovering resize also fails" is
unchanged.

### Desktop (`apps/desktop/tests/backend-terminal-input.test.ts`)

- The existing strict tests stay as they are.
- Add one test that resume crosses `BackendHttpClient.invoke` without an HTTP
  request.

### Hook (`useTerminal` tests)

- A failed write shows Resume and Reconnect.
- Resume invokes the right family and dismisses the toast.
- No session id, or a "not running" refusal, shows Reconnect only.

## Verification

- `mise run format:check`, `mise run lint`, `mise run typecheck`,
  `mise run test` (a `packages/protocol` change is wide-reaching).
- Real browser (`mise run test:agent:browser:isolated` profile):
  1. Open a terminal and start `vim`.
  2. Force an HTTP write failure, e.g. stop the backend briefly or block
     `/__orkestrator/invoke` in DevTools.
  3. Type: confirm input is rejected and the toast shows both actions.
  4. Restore the backend and resize the window: input stays fenced.
  5. Press Resume input: typing works, and vim's state matches what was
     echoed.
- `mise run test:agent:electron`: the same flow through the desktop client.
  Confirm Resume does not kill the PTY (same process id before and after).
- Inactive-environment path: fail a write, switch environments, return. The
  terminal is still fenced and Resume still works.

All three are automated, so they run with the agent suites:

- `e2e/agent-testing/terminal-input-resume.spec.ts` (browser suite) drives
  vim in a plain terminal tab. A page route forwards one `local_terminal_write`
  to the backend and then drops its response, so the keystroke lands but the
  client sees a failure. The spec checks the toast copy and both actions, that
  a resize goes through without re-arming input, that Resume sends nothing to
  the backend, that vim's saved buffer matches the echo, that the shell PID is
  unchanged, and the environment-switch path.
- `e2e/agent-testing/terminal-input-resume-electron.spec.ts` (Electron suite)
  runs the same flow through IPC and `BackendHttpClient`, injecting the lost
  response by wrapping `fetch` in the main process, and resizing the native
  window.

Both specs fail at the post-resize write when the old resize re-arm is put
back, so they guard this behaviour rather than just passing alongside it.

On hosts affected by the startup Claude login dialog
(`03-startup-claude-login-dialog.md`), `mise run test:agent:browser:isolated`
times out before it reaches the browser spec. Run it against a manual profile
instead: start `mise run dev:test --profile <name> --fixture
--no-agent-credentials --agent-platforms codex`, then run Playwright on the spec
with `ORKESTRATOR_AGENT_TEST_PROFILE=<name>`. The spec stubs the dialog itself.

## Rollout and risk

- **Visible change on web:** a transient failure no longer heals on the next
  resize; the user must press Resume. That is the intended trade, and the toast
  says what to do.
- **Revert:** this PR alone. The shared-core PR stands either way.
- **Old renderer against a new client, or the reverse:** both ship in one app
  bundle. The `Unknown backend command` fallback covers a renderer talking to a
  remote browser gateway from an older build.
- **No backend change.** Resume is client-side by construction, because the
  fence it clears lives in the client queue.

## Out of scope

- Telling the user how much of the lost input reached the shell. The backend
  cannot know; the terminal echo is the evidence Resume asks them to check.
- Retrying the lost write automatically. That is exactly the ambiguous retry
  the fence exists to prevent.
