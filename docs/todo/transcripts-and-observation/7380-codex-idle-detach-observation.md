# Codex idle detach cannot be observed without touching the session

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, while running
[0049](0049-native-agent-idle-observation.md) task 10 (the full detach wait)
with loopback fake models.

### Tasks

1. **Report Codex session attachment on the no-touch runtime read**: let the full detach wait observe a Codex thread go `detached` and come back `attached`. Status: open.
2. **Run the full detach wait for Codex**: the Codex half of 0049 task 10. Status: open (depends on 1).

### 1. Report Codex session attachment on the no-touch runtime read

**Problem.** 0049 task 10 asks for proof that the observation stream does not
keep an idle Claude or Codex session attached: `detached` before a follow-up
turn and `attached` after it, read through no-touch runtime discovery. Claude
now reports that (2026-11-06, 0049 task 10). Codex cannot: its runtime read
carries no session attachment at all, so the live spec records the Codex case
`not-exercised` whatever happens.

**Context.** The Codex bridge's `GET /session/:id/runtime-health` returns the
engine snapshot (`AppServerEngine.getRuntimeHealth`), and the backend maps it
through the legacy Codex shape in `bridgeRuntimeSummary`
(`apps/backend/src/core/http-bridge-runtime-health.ts`), where
`summary.state` is `engine.state`, the app-server child's health. The read is
already no-touch: `CodexRuntimeSessions.getRuntimeHealth` passes the thread id
only when the thread is loaded in the current generation (`loadedThreadId`),
which is exactly the attachment fact the spec needs. Codex detaches a thread
after `DEFAULT_THREAD_IDLE_MS` (30 min, `app-server-runtime-base.ts`) without a
touch of any of its sessions (`ThreadRegistry.detachableThreads`), and
tab-facing routes refresh that clock (`registry.touch`). Claude's window is 10
minutes of silence and ignores route touches, so the two providers detach on
different rules.

**Investigation.** Read only; no Codex detach was observed. Not established:
whether an open, idle Codex tab's reads reach a touching bridge route often
enough to keep its thread attached indefinitely. If they do, the full detach
wait can only be run with no renderer.

**Decisions.**

- **Where should Codex report attachment?**
  - **A separate session field on the Codex runtime-health body (for example `session: { state: "attached" | "detached" }`), copied by the backend into `summary.state` only for that session's read, keeping `engine.state` elsewhere (recommended).**
    - Pros: matches the Claude, Cursor and Pi vocabulary the spec already reads; the engine's health stays available; the fact is already computed (`loadedThreadId`).
    - Cons: a bridge and a backend change, and the AgentInfo panel's runtime line would show `attached` instead of the engine state for Codex.
  - **A new no-touch route for attachment only.**
    - Pros: leaves the runtime summary as it is.
    - Cons: one more route on the observation surface for a diagnostic.
- **What counts as the Codex detach wait?**
  - **A no-renderer wait just over 30 minutes (the tab closed or the page gone), then a turn from outside the view (recommended).**
    - Pros: tests the real window without a test-only knob; no tab read can refresh the clock.
    - Cons: over half an hour per run.
  - **Make `threadIdleMs` configurable for agent-test profiles and run with a short window.**
    - Pros: a short run.
    - Cons: a test-only bridge setting, and it no longer proves the default window.

### 2. Run the full detach wait for Codex

**Problem.** With task 1 in place, the Codex half of 0049 task 10 still needs
one live run.

**Context.** `idle-observation-live.spec.ts` with
`ORKESTRATOR_AGENT_TEST_IDLE_FAKE_MODELS=1` runs Codex against
`idle-observation-fake-codex.ts`, so the run needs no login and bills nothing.
The detach case requires `attached` at the start of the wait, `detached`
after it and `attached` after the follow-up turn.

**Investigation.** Not started; depends on task 1.

**Decisions.**

- **Which wait?**
  - **The one task 1 settles on, with `ORKESTRATOR_AGENT_TEST_IDLE_DETACH_WAIT_MS` set past it (recommended).**
    - Pros: one run proves the stream does not keep the thread attached.
    - Cons: long.
  - **Skip Codex and rely on the deterministic stream tests.**
    - Pros: no run.
    - Cons: leaves the end-to-end claim for Codex unproved.

## Related

- [0049 native agent idle observation](0049-native-agent-idle-observation.md), task 10.
