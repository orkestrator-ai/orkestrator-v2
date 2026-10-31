---
id: 105
title: "Agent signal tool"
phase: 1
plan: "P1.5"
status: not-started
depends_on: [102]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 105 · Agent signal tool

- **Plan:** [P1.5 Agent signal tool](../goals.md#p15-agent-signal-tool)
- **Decisions:** D4, D13
- **Depends on:** [102](102-goal-storage.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Any agent can say it is done or blocked, through the MCP server it already loads.

## Work

- [ ] Register the tool only for callers whose session has an active goal, or answer "no active goal" for others. Pick one and record why in Notes, considering catalogues that cache tool lists.
- [ ] Resolve the caller to one session. Per-tab credentials identify a tab. OpenCode has an environment credential only (`docs/architecture/agent-messaging.md`), so it needs the `tabId` hint the mail tools use; 301 finishes this.
- [ ] Treat `message` as untrusted, bounded text. It is stored as `lastReport` and rendered as text, never as instructions.
- [ ] Add it to the tools that never prompt, beside `AGENT_MAIL_TOOL_NAMES`, because a report blocked on approval would stall the loop it reports on. Keep the assertion that the server offers exactly the listed tools.
- [ ] A report arriving after the turn ended applies to the next evaluation, and a report for a replaced goal is ignored.

## Tests

- [ ] Caller resolution, wrong session, no active goal, oversize message.
- [ ] A coordinator's read-only policy still behaves as it does today.
- [ ] A `blocked` report ends the loop at the turn's end, not mid-turn.

## Done when

- [ ] All six bridges can reach the tool in unit tests, and the service sees a report for the right goal.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
