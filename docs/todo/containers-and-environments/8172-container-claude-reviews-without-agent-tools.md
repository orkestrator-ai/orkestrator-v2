# Container Claude reviews when the agent tools port is unreachable

## Task analysis

Analysed 2026-11-15 against `main` at `a8b89f154`. The findings come from a
run on beelink (Arch Linux, kernel 7.1.8, rootful Docker Engine 29.9.2, ufw
with a default-deny input policy) on 2026-11-06, while qualifying container
read-only Multi Review reviewers (to-do 0190, retired by #2252). They were
first written up in the unmerged PR #1938 as to-do 7360; that PR's e2e relay
and scripted fake were superseded on `main` (see Constraints and rationale),
so only these two findings are carried over.

### Tasks

1. **A Claude review fails at its second turn when MCP is unreachable**: a container's Claude bridge runs a session's first turn without the required Orkestrator MCP server and refuses every later turn with 409. Status: open.
2. **A failed Multi Review refuses delete and start with a message that says "running"**: `failed` is deliberately not terminal, so the refusal is intended, but its wording is wrong. Status: open.

### 1. A Claude review fails at its second turn when MCP is unreachable

**Problem.** In a container whose agent tools port the host firewall drops,
a Multi Review with Claude on the shared preparation and consolidation
session fails. Preparation's first turn runs, but its correction turn (and
consolidation, which reuses the session) is refused by the bridge with
`claude prompt dispatch is temporarily unavailable (HTTP 409): Claude
required MCP server is not connected; retry the prompt`. The review moves to
`failed`. This happened with the structured-output transport too, which
does not need MCP to submit a result.

**Context.** The required server is the injected Orkestrator agent MCP
(`ORKESTRATOR_AGENT_MCP_URL`, `http://host.docker.internal:<port>/mcp`).
`syncClaudeRuntimeMcp` (`bridges/claude-bridge/src/services/session-manager-prompt-mcp-sync.ts`)
checks the required servers' status when a turn joins a running CLI
(`session-manager-prompt-launch.ts`) and throws the 409 when one is not
`connected`. A turn that launches a new CLI does not go through it, so the
first turn goes ahead. On beelink the profile's port is unreachable from
containers ([7080](7080-linux-host-firewall-blocks-profile-signals.md)); the
backend does show "Agents in Docker containers can't reach Orkestrator, so
container review and pipeline stages can't report results." when its
reachability check runs. [7080](7080-linux-host-firewall-blocks-profile-signals.md)
records the same refusal for a container's native Claude tab (the retired
0049 task 9) as prose only; nothing tracks it as work.

**Investigation.** Seen twice on 2026-11-06 in profile `r0190c` (workflows
started with `start_multi_review`, Claude `haiku` for every step), each time
on preparation's schema-correction turn. Each bridge start logged
`probe.result trigger=bridge-start … outcome=timeout` for the agent tools
URL. With the port relayed the same reviews completed, so the refusal is the
only blocker. Re-checked 2026-11-15: the 409 text and the join-only check are
unchanged on `main`. Not checked: what a user sees on the renderer's "Retry
failed stage" for this failure, and whether a reviewer session (one turn)
ever reaches the check.

**Decisions.**

- **What should a turn do when its required MCP server cannot connect?**
  - **Refuse up front, on the first turn too, with an error that names the unreachable agent tools URL and points at the reachability notice (recommended).**
    - Pros: one consistent answer; the user learns the cause instead of "retry"; no half-finished preparation.
    - Cons: a review that would have worked on the structured-output transport now fails earlier.
  - **Let structured-output turns run without the server and refuse only tool-transport turns.**
    - Pros: reviews keep working on hosts like beelink when the rollout uses structured output.
    - Cons: the default transport is tools, so most users still fail; widens a rule the bridge applies uniformly today.
  - **Keep today's behaviour.**
    - Pros: no change.
    - Cons: the first turn succeeds and the second fails with a message that suggests retrying, which cannot help.

### 2. A failed Multi Review refuses delete and start with a message that says "running"

**Problem.** With a workflow in phase `failed`, `delete_multi_review_workflow`
answered "Cancel or finish the running Multi Review before deleting it", and
`start_multi_review` answered "Finish, cancel, or delete the existing Multi
Review before starting another". `cancel_multi_review` then answered
`cancelling`, after which delete succeeded. Observed through the backend
commands on 2026-11-06.

**Context.** `MultiReviewService.close` (`apps/backend/src/core/multi-review-service.ts`)
refuses any workflow whose phase is not terminal, and
`isMultiReviewTerminalPhase` (`packages/protocol/src/multi-review.ts`) is true
only for `interactive`, `completed` and `cancelled`, so `failed` counts as
active. `createMultiReviewWorkflowIfNoActive` applies the same rule to a new
start.

**Investigation.** Traced 2026-11-15. The behaviour is deliberate, not a
backend slip: the tab (`MultiReviewTab.tsx`) offers "Retry failed stage" and
"Abandon" (which cancels) on a `failed` workflow and no Delete, and closing the
tab leaves a failed workflow in place so the launcher can reattach it
(`DraggableTabBar.tsx`, `closeParentMultiReviews`: "Active, failed, and
not-yet-hydrated reviews remain backend-owned when hidden"). A user reaches
delete only through Abandon first. What is wrong is the wording: "running"
is untrue for a failed review, and neither message says to retry or abandon it.

**Decisions.**

- **How should a `failed` review's refusal read?**
  - **Keep `failed` active and reword both refusals to name the phase and the way out, "retry the failed stage or abandon it first" (recommended).**
    - Pros: matches what the UI offers and the reattach design; no behaviour change to retry; a few strings and their tests.
    - Cons: a command-line user still needs two calls (cancel, then delete).
  - **Make `failed` terminal for delete and start only.**
    - Pros: one call for tools that drive the backend directly.
    - Cons: a failed review that still offers Retry could be deleted from under it; splits "terminal" into two meanings across the protocol helper and the store's active check.
  - **Keep today's text.**
    - Pros: no change.
    - Cons: the wording "running" is wrong for a failed review either way.

## Constraints and rationale

- Not carried over from PR #1938: the agent-tools relay (a DNAT workaround for firewalled Linux hosts) is replaced by `dev:test --agent-tools-port` (range 31500–31509, [7080](7080-linux-host-firewall-blocks-profile-signals.md) task 2) and `docker:disposable -- start --host-loopback`; the scripted Multi Review turn in `container-fake-claude-api.ts` is replaced by `container-fake-claude-review-api.ts` and the opt-in `container-multi-review-read-only.spec.ts`, which passed on rootless Docker in #2252. The old 7360 task 2, automating that run, is therefore done.
- A live check of task 1 needs a Linux host whose firewall drops the profile's agent tools port, or any profile started so containers cannot reach it; use an isolated `dev:test` profile with `--fixture` and the fake Claude review API, never a production instance.

## Related

- [7080-linux-host-firewall-blocks-profile-signals.md](7080-linux-host-firewall-blocks-profile-signals.md)
