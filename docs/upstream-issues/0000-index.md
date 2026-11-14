# Upstream issues

Ready-to-paste bug reports and feature requests that Orkestrator wants filed with another project. There is one file per upstream report. These are not to-dos (decided by the user on 2026-11-14). The to-do that found the problem keeps the work on our side and links here.

- Agents draft and update these files. Only the user files them; agents never post them.
- When a report is filed, the user or an agent records its URL and date under **Filed** and sets **Status** to `filed`, then links the issue from the source to-do task.
- When the upstream fix ships, the source to-do acts on it (adopts the fix, flips the canary, removes the workaround). The file may then be deleted, and the to-do cites it where it records the outcome.

## File names

`<project>-<kebab-case-summary>.md`, for example `bun-fsevents-rebuild-loses-events.md`. No number and no number claim: the project prefix and the summary identify a report.

## Status values

- `draft`: something under **Before filing** is still open beyond the routine duplicate search (a re-run on the current pin, a canary check, a version to confirm).
- `ready to file`: only the duplicate search is left.
- `filed`: filed upstream; **Filed** holds the URL and date.

## Each file holds

A title, then **Tracker**, **Status**, **Source** and **Filed**; then `## Issue text` (a proposed title and the body, ready to paste), `## Existing-report search`, `## Before filing` and `## After filing`. Issue text carries no prompts, tokens, secrets, home-directory paths or user data.

## Reports

| File | Tracker | Status | Source |
| --- | --- | --- | --- |
| [grok-never-trust-switch.md](grok-never-trust-switch.md) | xAI, Grok Build CLI (channel to confirm) | draft | [0001](../todo/agent-engines/0001-agent-interactions-and-permissions.md) task 1 (item 12) |
| [claude-agent-sdk-slash-command-terminal-flag.md](claude-agent-sdk-slash-command-terminal-flag.md) | github.com/anthropics/claude-agent-sdk-typescript | draft | 0016 (retired) task 1 |
| [claude-code-replaced-mcp-server-lingers.md](claude-code-replaced-mcp-server-lingers.md) | github.com/anthropics/claude-code | draft | [0039](../todo/mcp/0039-mcp-management.md) task 1 (code item 8) |
| [moby-rootless-docker-cp-readonly-bind.md](moby-rootless-docker-cp-readonly-bind.md) | github.com/moby/moby | draft | [7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md) task 1 |
| [bun-fsevents-rebuild-loses-events.md](bun-fsevents-rebuild-loses-events.md) | github.com/oven-sh/bun | draft | [7551](../todo/cross-cutting/7551-macos-watch-churn-loses-events.md) task 2 |
| [bun-nested-tick-loses-child-process-events.md](bun-nested-tick-loses-child-process-events.md) | github.com/oven-sh/bun | draft | 4260 (retired) task 1; [6900](../todo/cross-cutting/6900-reproduce-lost-child-event-on-pipe-capture.md) tasks 1, 3 and 4 |
| [pi-bounded-session-listing.md](pi-bounded-session-listing.md) | github.com/earendil-works/pi | draft | [5980](../todo/agent-engines/5980-pi-session-list-read-cost.md) task 1 |
