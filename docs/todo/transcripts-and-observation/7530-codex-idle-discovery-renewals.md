# An idle Codex view is woken by discovery renewals that Claude's never sees

## Task analysis

Analysed 2026-11-06 against `main` at `ee2cc8423`, while running
[0049](0049-native-agent-idle-observation.md) task 4 (per-cause idle
invalidation counts) with loopback fake models on beelink.

### Tasks

1. **Name the discovery section whose renewal changes on an idle Codex view**: count `discovery-renewal` announcements per section, then rerun the idle case. Status: open.
2. **Stop the repeating renewal**: once the section and field are known, keep the value stable or exclude the field from the comparison. Status: open (depends on 1).

### 1. Name the discovery section whose renewal changes on an idle Codex view

**Problem.** In a 300 s idle window an idle Codex view read 13.3 times a
minute against Claude's 8, and its read gaps kept falling back to the short
steps (`2-6s` 11, `6-12s` 6, `>=12s` 10; Claude: 1, 1 and 17). Task 4's cause
tags name the source: six `discovery-renewal` invalidations for Codex, none of
any other cause, and none at all for Claude. Each one is a renewal whose value
changed, and each resets the view's quiet backoff to its 3 s step, so an idle
Codex tab costs about 1.6 times an idle Claude tab's reads.

**Context.** Loopback-model runs on beelink, 2026-11-06, profile
`idleqa-0049-r2`: `idleqa-0049-r2-claude` and `idleqa-0049-r2-codex`
(`ORKESTRATOR_AGENT_TEST_IDLE_CASES=…,detach`,
`ORKESTRATOR_AGENT_TEST_IDLE_DETACH_WAIT_MS=300000`), each after the approval,
sub-agent, background, reconnect, hidden and no-renderer cases on the same
session. A renewal announces only when `storeProgressiveDiscovery` reports
the stored value changed (`native-agent-transcript-projection.ts`, the
`discovery-renewal` announcement). The tag says that a section changed, not
which one.

**Investigation.** A throwaway probe (not committed) read all four sections
(`models`, `commands`, `mcp`, `runtime`) of a fresh idle Codex session every
31 s, seven times, through `get_native_agent_discovery_update` with the
view's own arguments, and hashed every value field: after the first load
nothing changed, whether the session had taken a plain turn, a backgrounded
command, a sub-agent turn, or an approval-mode switch with an async question
and its answer. So the moving value depends on something only the spec's
session had: a rendered view reading with its `knownToken`, the earlier
cases' combined history, or the environment's age. Codex's own log over the
idle window shows no app-server notification at all, only the bridge's
`mcpServerStatus/list`, `skills/list`, `hooks/list` and
`account/rateLimits/read` requests, so no new runtime notice arrived.
`skills/list` for the fixture returned no load errors, which rules out the
per-read `receivedAt` on skill-load notices (`skillLoadNotices`).

**Decisions.**

- **How to name the section?**
  - **Count `discovery-renewal` announcements per section in `NativeSessionInvalidationMetrics`, content-free (section names only), and read them in the idle case (recommended).**
    - Pros: answers the question from the next idle run with no guesswork;
      stays diagnostic.
    - Cons: one more counter dimension.
  - **Repeat the probe with a rendered view attached.**
    - Pros: no code.
    - Cons: the probe could not reproduce it four times; another blind try.

### 2. Stop the repeating renewal

**Problem.** Whatever field moves, an unchanged idle Codex session should
announce nothing, as Claude's does.

**Context.** The same fix shape as 0049 code item 5: drop or stabilise the
field that changes (a timestamp, a counter, an ordering) before the
comparison.

**Investigation.** Not started; depends on task 1.

**Decisions.**

- **Where to fix it?**
  - **In the backend comparison (`storeProgressiveDiscovery`), excluding the moving field (recommended once named).**
    - Pros: one place for every bridge.
    - Cons: the field must not be one a view needs to see change.
  - **In the Codex bridge, making the field stable.**
    - Pros: fixes it at the source.
    - Cons: older bridges keep the cost.

## Related

- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md)
  task 4, which found this, and task 6 (OpenCode's idle hints, the same kind
  of question).
