# Label the project home in listings and prove the message gate live

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Label the home in `list_environments`**: the model can tell the project home from a worker before acting on it. Status: open.
2. **Add a live read-only step**: mail the home through a real provider and check that the checkout digest is unchanged while approval is pending. Status: open.

### 1. Label the home in `list_environments`

**Problem.** To the model the project home looks like an ordinary worker. It learns otherwise only when a call is refused.

**Context.** The report's first choice, refusing the home outright and hiding it, was superseded: `5161688cf` (#1632) allows a message with a reason and usually the user's approval (see [Current state](#current-state)). The home therefore has to stay addressable, so a filter is no longer the right fix for a local listing.

**Investigation.** The local listing filters the home only for node targets (`control-mcp-tools.ts:932`). `environmentSummary` has no `projectHome` field (`control-shared-actions.ts:60-80`). `get_environment` on the home is refused outright (`control-mcp-server.ts:603`), so the model cannot look it up either.

**Decisions.**

- **Label it or hide it?**
  - **Add `projectHome: true` to the coordinator's listing row (recommended).**
    - Pros: the routing rule's "exceptional circumstances" can be followed knowingly; the gate needs the id to be discoverable.
    - Cons: one more field on every row (absent for workers, so nearly no cost); operator reads share `environmentSummary`, so add it only in the coordinator branch.
  - **Hide it and put the id in the routing rule.**
    - Pros: the model is never tempted.
    - Cons: a per-turn prompt line for an exceptional case, and hiding contradicts a rule that allows it.

### 2. Add a live read-only step

**Problem.** The gate has unit evidence only. The live read-only scenario proves `launch_job` is refused on the home, but not this route.

**Context.** The report's roadmap asks for the step. `docs/todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md` describes the existing case and calls `launch_job` "the one Control MCP route to a write in the checkout", which has been out of date since #1632.

**Investigation.** `apps/desktop/scripts/dev/coordinator-live.ts:222` is the home probe, with `homeEnvironmentId` at `:198` and the home-work check at `:579-627`. Nothing there sends mail to the home. `coordinator-worker-mail.test.ts` and `control-mcp-server-messaging.test.ts` cover the gate without a provider.

**Decisions.**

- **What does the step assert?**
  - **`send_message` with no reason is refused, with a reason it is held as pending, and the digest and home work are unchanged (recommended).**
    - Pros: covers what a read-only coordinator can do unattended; needs no approval click.
    - Cons: does not exercise the send after approval, which the unit tests cover.
  - **Approve it too, and check the delivered mail.**
    - Pros: the whole round trip.
    - Cons: an approved message legitimately writes to the checkout, so it cannot be a read-only check.

## Current state

- `send_coordinator_agent_mail` requires `projectHomeReason`, holds the message for approval, and allows it for 3 hours after a sent message (`coordinator-worker-mail.ts:417-432`, `:268-336`). The user's dialog is `ProjectHomeMessageApprovalDialog`, described in `docs/architecture/coordinator.md:1178-1216`.
- The scheduled route goes through the same gate: a `send_message` schedule calls the coordinator's own tool (`scheduled-jobs/tools.ts:219-229`, `scheduled-jobs/executor.ts:594-596`, `:639`). That action has no reason field, so it is refused; a generic `tool` schedule reaches the same command and the same approval. So the report's concern about `create_schedule` does not hold.
- A node's home stays refused (`coordinator.md:1213-1216`), and the regression tests are in `coordinator-worker-mail.test.ts`.

## Constraints and rationale

- This changes the report's stance: it wanted the home refused, and the shipped design allows it with approval. Security finding M10 recommends the same refusal, so that report is out of date on this point too.

## Related

- [Coordinator report, 4.1 (S1)](../2026-10-27-coordinator.md#41-security-and-boundary) and [7](../2026-10-27-coordinator.md#7-suggested-roadmap)
- [Security report, M10](../2-26-10-27-security.md)
- [0024-coordinator-live-conformance.md](../../todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md)
- [1021-coordinator-gap-tools-follow-ups.md](../../todo/coordinator-and-multi-review/1021-coordinator-gap-tools-follow-ups.md): the approval dialog's fixture
