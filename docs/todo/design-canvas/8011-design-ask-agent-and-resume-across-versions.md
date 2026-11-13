# Design canvas: Ask agent and Resume across a published release

## Task analysis

Analysed 2026-11-13 against `main` at `17d28238c`. Split from to-do 0036 task 6
(0036 retired 2026-11-13), whose recommended run named "open, edit, export,
Ask agent and Resume" in both directions of the desktop pairing.

### Tasks

1. **Ask agent and Resume in both pairing directions with a loopback model**: extend `e2e/agent-testing/design-canvas-renderer-pairing-electron.spec.ts` past the canvas journey. Status: open.

### 1. Ask agent and Resume in both pairing directions with a loopback model

**Problem.** On 2026-11-13 the pairing spec ran the design canvas journey (open, drag, keyboard, export, host import, and the download where main is reachable) with this checkout's packaged renderer on a published `orkestrator@2.22.3` backend, and with the published v2.22.3 desktop renderer on this checkout's backend. Both passed. **Ask agent** (send a selection with design context to an agent conversation) and **Resume** (reopen a closed design conversation from its link) were not run in either direction, because both need an agent turn and the pairing backends have no agent.

**Context.**
- The Ask agent dialog and link states live in `apps/web/src/components/design/DesignAgentDialog.tsx` and `design-session-links.ts`. `design_session_link_states` was added on 2026-10-24, so v2.21–v2.23 backends lack it; the renderer maps the `unsupported` refusal to a closed link (`design-session-links.ts`, "unsupported"), which is unit-tested but has never met a real old backend.
- The pairing spec's backends run `--runtime-flavor agent-test` with a toolchain directory that holds only a stub `pi` (`design-renderer-pairing-support.ts`), so no provider turn can start. The stub exists only so the renderer's "AI CLI Required" gate stays closed.
- The repository already runs real Pi bridges against a loopback OpenAI-compatible model with no login and nothing billed (`e2e/agent-testing/auto-pipeline-fake-model.ts` and its siblings). Design launch itself offers only Claude and Codex (`DESIGN_AGENTS`), while Ask agent can target an existing conversation.
- The published v2.22.3 desktop build is reachable only over CDP (inspect fuse off). Its executable comes from the GitHub release zip, unpacked into a new empty directory under `output/agent-testing/` and named by `ORKESTRATOR_PAIRING_OLD_APP_EXECUTABLE`.

**Investigation.** Not started. Open points: whether a v2.22.3 backend's Pi bridge can run against the loopback model with the same `models.json` shape, and whether Ask agent can target a Pi conversation in both renderers (the dialog's destinations come from the environment's native tabs).

**Decisions.**

- **How to give the pairing an agent?**
  - **A real Pi conversation on the loopback model, created in the paired environment before Ask agent (recommended).**
    - Pros: no login and no billed turn; reuses the fake-model pattern the auto-pipeline and coordinator specs already use; exercises the real dispatch and link paths on both versions.
    - Cons: Pi may not be an Ask agent destination on v2.22.3; the old backend's Pi bridge and `models.json` handling must be checked first.
  - **Live Claude or Codex logins.**
    - Pros: the providers design launch supports.
    - Cons: a real login and billed turns, which would make this a manual-test checklist item.
  - **Retire the step as covered by unit tests.**
    - Pros: no work.
    - Cons: the `design_session_link_states` fallback has never met a real old backend.
- **What counts as a pass?** In each direction: Ask agent sends the selection to the conversation exactly once, the canvas shows the link, closing the conversation's tab shows the link as closed (on the old backend through the `unsupported` fallback), and Resume reopens that conversation in a new tab with its transcript and nothing sent.

## Constraints and rationale

- No real login, credential or billed turn: `--no-agent-credentials`-equivalent isolation and a loopback model only. Anything that needs a real provider belongs in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md).
- Never bind ports 34121, 34122 or 45507; the support module already refuses them (`FORBIDDEN_PORTS`).
- The published release stays in the support window until its floor passes it (`version-compatibility.md`, "The support window"); after that, pick the oldest Stable release still inside it.

## Related

- [`design-canvas.md` → Tests](../../architecture/design-canvas.md#tests): the pairing spec and what it covers.
- [`version-compatibility.md`](../../architecture/version-compatibility.md#what-must-work-across-the-window): the desktop-to-remote-backend pairing rule.
- 0036 (retired 2026-11-13): the 2026-11-13 pairing evidence, "Renderer pairing with v2.22.3 (task 6)" in [`design-canvas.md` → Evidence of 2026-11-13](../../architecture/design-canvas.md#evidence-of-2026-11-13); the to-do's earlier record is `git show 17d28238c:docs/todo/design-canvas/0036-design-canvas-qualification.md`.
