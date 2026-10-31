# Agent registry

Status: Living — `apps/backend/src/core/agent-registry.ts`,
`packages/protocol/src/agent-registry.ts`.

One backend answer to "which agents exist, and what is each doing?", for every
part of the app that needs it: the coordinator, the sidebar, and other
services.

## What it lists

Every agent tab in every environment, from the committed pane layouts:

| Tab | `kind` | State from |
| --- | --- | --- |
| `agent-native` | `native` | The native activity observer, turn view (`sessionTurnActivitySnapshot`): a turn with only background work left reads idle |
| `claude-tmux` | `tmux` | The tmux session's hook-driven `activityState()` |
| Terminal agents (`claude`, `codex`, …) | `terminal` | None: a terminal CLI reports no per-tab activity, so `unknown` |

Plus every open coordinator conversation (`ownerKind: "coordinator"`, with
`coordinatorRole`). Plain shells, browser and review/workflow tabs are not
agent tabs. A coordinator's `environmentId` is its runtime ID, not an environment
record.

A native entry whose platform is chosen carries `sessionId`, the public session
handle ([control-mcp.md](control-mcp.md#coordinator-conversations)).

`state` is `working`, `waiting` (blocked on a person), `idle`, `stopped` (the
environment, or the coordinator, is not running) or `unknown` (never observed).
Each snapshot also carries per-environment counts.

A native tab with a goal also has `goal`: its status, reason, iterations, limit
and whether it has a check, and never its text. `state` is about the current
turn, so a tab between a goal's iterations reads `idle` while `goal.running` says
it will continue. Read from the session record, so a snapshot still never waits
on a provider.

## Who reads it

- `get_agent_registry({ projectId?, environmentId? })` — backend command.
- Control MCP `list_agents` — the coordinator's view of its project.
- The environment hover card in the sidebar ("3 agent tabs · 1 working"),
  read when the card opens and kept current while it is open
  (`EnvironmentAgentSummary`).

The sidebar's working/waiting icon colour comes from the environment's
persisted aggregate (`agentActivityState`), which the same observers write, and
stays there (decided 2026-10-25). The aggregate is a persisted, announced
`environment` field, so every sidebar row is current on reload and for
environments nobody has opened; moving the icon onto the registry would make
each row re-read the registry on every native activity invalidation, since the
registry has no event of its own. Per-tab attention that must not be inferred
from the aggregate (a delegated worker waiting on a person) is read from that
tab's own state instead, as the coordinator's waiting marker does.

## Properties

- Reads only in-memory activity and cached records; a snapshot never waits on
  a provider, and covers environments that are not on screen.
- It has no event of its own, because everything it is derived from already
  announces changes. A live consumer re-reads it on those: native activity
  invalidations (`subscribeNativeObservationInvalidations`) for the
  environment, `environment` and `pane-layout` resource changes (tmux activity
  reaches the environment's persisted aggregate), `coordinator` changes for
  coordinator conversations, and resync requests — debounced, newest read
  wins. The hover card is the reference implementation.
