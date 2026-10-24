# A resumed Codex conversation shows Codex's environment context as a user message

Checked against `main` at `8454d18b8` (2026-10-24).

Found while qualifying design conversation links live
([0038-design-agent-conversation-links.md](../design-canvas/0038-design-agent-conversation-links.md)).
After a Codex conversation is resumed, the transcript gains a **You** message
holding Codex's synthetic `<environment_context>` block (working directory,
shell, date, timezone, sandbox). The live tab never showed it. A user can read
it as a prompt Orkestrator sent on their behalf; nothing was sent.

## Current state

- Observed 2026-10-24 on mbp3, disposable profile `qa-design-live-0038`: a
  Codex design conversation's live projection held one user message; after
  closing the tab and resuming the thread, the projection and the rendered
  transcript held two, the first being `<environment_context>…`. The rollout
  still held one turn (`task_started` once), so no prompt was dispatched. The
  live design spec (`e2e/agent-testing/design-live.spec.ts`) saw 3 user
  messages live and 4 after resume for the same reason.
- Resume goes through `resume_native_agent_session` → the Codex bridge's
  `resumeSession` → `thread/resume` with `includeTurns: true`, whose turns are
  reduced by `reduceHistoricalTurns`
  (`bridges/codex-bridge/src/app-server/event-reducer.ts`). The same path
  serves a tab's own **Resume Session** picker, so this is not specific to
  design links.
- Nothing in the repository filters `<environment_context>`.

## Outstanding work

1. In the Codex bridge, drop a historical user message whose whole text is an
   `<environment_context>` block (and check whether `<user_instructions>` and
   similar synthetic items need the same), so a resumed transcript matches the
   live one. Read `bridges/AGENTS.md` and `bridges/codex-bridge/AGENTS.md`
   first.
2. Bridge test: a resumed thread whose turns start with an environment-context
   user item renders the same user messages as the live stream did.
3. Then drop the environment-context exclusion from the resume step of
   `e2e/agent-testing/design-live.spec.ts`.

## Constraints and rationale

- Filter only exact synthetic blocks; a user prompt that mentions the tag must
  still render.

## Related

- [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md)
  (Codex history semantics).
