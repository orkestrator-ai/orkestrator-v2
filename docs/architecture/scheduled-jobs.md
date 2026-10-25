# Scheduled jobs

Status: Living — backend-timed schedules: model, timing and DST rules,
missed-fire catch-up, exactly-once claims, authority, surfaces and the
decisions behind them.

A schedule tells the backend to do one thing at a set time: once ("at 03:12
tomorrow") or repeatedly (a cron expression or a fixed interval). The backend
owns the timing. Nothing depends on an agent session staying alive, awake or
connected, so a coordinator can say "wake me at 03:12 and I will resume the
stalled workers" in one durable tool call and end its turn.

| File | Purpose |
| --- | --- |
| `packages/protocol/src/scheduled-jobs.ts` | Record types, limits, trigger normalization, next-slot maths, owner keys |
| `packages/protocol/src/schedule-time.ts` | Time zones, cron parsing, DST-aware next fire, one-shot time forms (`Intl` only, shared with the renderer's preview) |
| `apps/backend/src/core/scheduled-jobs/model.ts` | Pure state transitions run inside one storage transaction: claim, heartbeat, settle, pause, resume, manual run |
| `apps/backend/src/core/scheduled-jobs/store.ts`, `layout.ts` | The `scheduled-jobs` database store, one row per schedule |
| `apps/backend/src/core/scheduled-jobs/service.ts` | Timer loop, claims, execution with heartbeats, CRUD with visibility rules, lifecycle hooks |
| `apps/backend/src/core/scheduled-jobs/executor.ts` | Runs a fire as its owner; refuses at creation what the owner could not do |
| `apps/backend/src/core/scheduled-jobs/tools.ts` | `create_schedule`, `list_schedules`, `cancel_schedule` for agents and coordinators |
| `apps/backend/src/core/mcp-in-process.ts` | Calls one MCP tool of a scoped server in-process |
| `apps/backend/src/core/public-api/actions-schedules.ts` | The `schedule.*` public actions (CLI, Control MCP operator credentials) |
| `apps/backend/src/core/commands-registry-scheduled-jobs.ts` | Registry commands the UI and the coordinator tools call |
| `apps/web/src/components/settings/SchedulesSettings.tsx` | Settings → Schedules |
| `packages/cli/src/client/commands/schedule.ts` | `orkestrator schedule …` |

## Model

A schedule (`ScheduledJob`) records:

- **owner** and **ownerLabel**: who created it, and so whose authority each
  fire runs with (see [Authority](#authority)). `ownerKey` is the indexed row
  owner (`operator`, `control-mcp:<id>`, `env:<environmentId>`,
  `coordinator:<id>` or `coordinator:<id>:<conversation>` for a side agent).
- **trigger**: `{kind: "once", at}`, `{kind: "cron", expression}` or
  `{kind: "interval", everySeconds, anchorAt}`, normalized at creation.
- **timeZone**: an IANA zone, always stored. It defaults to the backend
  host's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`, `UTC` when
  the runtime cannot name one).
- **action**: what fires (see [Actions](#actions)).
- **catchUpMinutes**: the per-schedule missed-fire window (default 15, 0 to
  10 080).
- **state**: `active`, `paused` (with `pausedReason`: `user`,
  `target-deleted` or `authority-lost`, and a message) or `completed` (a
  one-shot that fired, or a schedule with no future slot).
- **nextFireAt**, **revision**, **fireCount**, and **fires**: the bounded
  history (20 fires; pending and running fires are never dropped).

Each **fire** has a stable `fireId`: `<scheduleId>@<slot epoch ms>` for a
scheduled slot and `<scheduleId>@run-<n>` for a manual run. Its state is
`pending`, `running`, `succeeded`, `failed` or `skipped`, with the attempt
count, a separate count of stale-claim interruptions, the claiming backend's token and heartbeat, start and finish times,
the number of coalesced missed slots, an `{code, message}` error and a small,
content-free outcome (operation, message, environment, session and run ids;
the base a launch resolved).

"Succeeded" means the action was **accepted**, as everywhere in the public
API ("Responses mean submitted"). A launched environment or a prompted turn
keeps running; follow it with `run get <operationId>` or in the app.

## Timing

`ScheduledJobService` arms one timer for the earliest moment any schedule
needs attention (its next slot, a pending retry, a running fire's heartbeat
deadline), capped at 30 s (`SAFETY_TICK_MS`). The cap makes a schedule
written by another backend sharing the data directory, a wall-clock change or
a host sleep visible within 30 s; `HostSuspendDetector` also wakes it on
resume. A tick lists the store (one uncached indexed read), claims due fires
row by row, executes up to four at once, and re-arms. Deadlines are wall
clock (`Date.now()`), not monotonic: a schedule names a time of day.

### Cron and DST

Cron expressions have five fields (minute, hour, day of month, month, day
of week) with lists, ranges, steps, month and weekday names, `7` as Sunday,
and `@yearly`/`@monthly`/`@weekly`/`@daily`/`@hourly`. When both day fields
are restricted a day matching either fires (classic cron). Wall times are
evaluated in the schedule's zone, with the same disambiguation as
`Temporal`'s default (`compatible`):

- A wall time that does not exist (the spring-forward gap; 01:30 in London
  on the last Sunday of March) fires once at the same wall time shifted
  forward by the gap: 02:30 BST.
- A wall time that occurs twice (the autumn fall-back hour) fires once, at
  its first occurrence, when the hour field names fixed hours (`30 1 * * *`).
  An expression whose hour field is `*` follows real time and fires in both
  copies of the repeated hour, so `*/15 * * * *` keeps its rhythm through the
  change.

The search walks calendar days in the zone. Days without an offset change are
plain arithmetic; a day with a change finds the change once by bisection and
classifies each wall time arithmetically. An expression that cannot fire in
five years (`0 0 31 2 *`) is refused at creation.

Intervals are elapsed time from an anchor (default: one interval after
creation), at least 60 s, and ignore the zone and DST entirely.

One-shot `at` accepts `HH:MM[:SS]` (its next occurrence in the zone: today if
still ahead, else tomorrow), `YYYY-MM-DDTHH:MM[:SS]` or with a space (a wall
time in the zone), an ISO time with `Z` or an offset (absolute), and relative
`+90s`, `+15m`, `+2h`, `+1d`, `+1h30m`.

### Missed fires

When a slot has passed by the time the scheduler looks (the backend was down,
the host slept, a fire of the same schedule was still running), every slot
up to now is coalesced into the latest one:

- If that latest slot is no more than `max(catchUpMinutes, 1 minute)` late,
  it fires **once** (`kind: "catch-up"` when more than a minute late), with
  `missed` counting the earlier coalesced slots.
- Otherwise it is recorded as `skipped` with error `missed` and the count.

Either way `nextFireAt` moves strictly past now, so missed ticks are never
replayed one by one. The one-minute floor keeps timer slop and short host
pauses from ever counting as missed, even with `catchUpMinutes: 0`. Time a
schedule spends paused is not caught up: resuming starts at the next slot
after now.

### Exactly once

- **Claims are transactions.** Moving a fire to `running` is one
  `updateStoreRow` (`BEGIN IMMEDIATE`) that re-reads the row, so two backends
  sharing a data directory can never both claim it. The store's only kind of
  writer is that single-row transaction ([storage.md](storage.md#concurrency)).
- **Only the writer fires.** The service fires only while this backend holds
  the registry writer lease (`registry-writer-lease.ts`), the same
  single-writer guard container reconciliation uses. Any backend may create
  and edit schedules; the writer picks the change up within one safety tick.
- **One fire per schedule at a time.** A running fire or pending busy retry blocks the next slot
  until it settles.
- **Request keys make re-runs replays.** Every dispatch carries the request
  key `sched:<fireId>`: the public operation ledger, agent-mail idempotency
  and the coordinator's durable receipts all return the first attempt's
  outcome for a repeated key.
- **Abandoned fires are re-claimed.** A running fire heartbeats every 20 s. A
  fire whose heartbeat is 90 s old was left by a backend that stopped; the
  writer re-claims it and dispatches again under the same key (a replay if
  the first attempt got through). After three stale claims it fails as
  `interrupted`; busy refusals do not consume this recovery budget. A fire that fails while its own backend is shutting down is
  left running for the next backend rather than recorded as a failure.
- **Busy targets retry.** A refusal the target can outgrow (`busy`,
  `not-ready`, `dispatch-parked`, no main coordinator open) returns the fire
  to `pending` and retries every 30 s for up to 15 minutes from its first
  attempt, then fails. A refusal before admission consumes no request key.

## Actions

| Kind | Operator / Control MCP credential | Agent | Coordinator |
| --- | --- | --- | --- |
| `action` | Any public **mutation** by name with its input (`mail.send`, `ticket.comment`, …) | One of its own agent tools by name (`send_message`, `create_ticket`, …) | One of its own tools by name (`send_message`, `start_environment`, …) |
| `prompt` | `session.prompt` to an idle session | Refused | `send_prompt_to_tab` (with `nodeId`) |
| `launch` | `environment.launch` | Refused | `launch_environment` (with `nodeId`) |

`mail.send` is accepted on every surface and means "send agent mail as the
owner": external, inbox-only mail for the operator; the agent's or
coordinator's own `send_message` otherwise, with its normal routing (a
worker's mail to `"coordinator"` wakes it; peer mail follows the recipient's
policy).

A **reminder to oneself** is the one addition. No tab may mail its own
mailbox, so mail from an agent to its own environment (and tab), or from a
coordinator to `"coordinator"` or its own runtime id, is delivered as a
backend notice: a system sender (`source: "workflow"`, `resourceId` = the
schedule id) like a workflow status notice, which wakes the recipient subject
to mute, Off, pause and the hop budget. Mail to `"coordinator"` resolves to
whichever conversation is main when it fires and starts one if none is open,
exactly as a worker's mail would.

A **launch** without `baseCommit` resolves its base when it fires: the newest
commit of `baseBranch` (the repository's base branch by default), fetched
through `get_project_base_branch_tip`, which now takes an optional `branch`.
The resolved pair is persisted on the claimed fire before dispatch and reused
on every busy retry or stale-claim recovery. A coordinator launch on another
node resolves that node's default base through `get_launch_options`; a
different branch on another node needs a pinned `baseCommit`. An operator
launch with neither field resolves and persists the default branch and its tip
through the same path.

A schedule can never create, change or cancel schedules, never runs a read,
and never runs an action that always needs a confirmation (`project.create`,
`environment.delete`, `environment.recreate --discard`, …), since nobody can
confirm at fire time.

## Authority

A schedule runs with the authority of whoever created it, re-established at
every fire:

- **Operator** (UI, `orkestrator` CLI): `public_action` as `operator`.
- **Control MCP credential**: `public_action` as `control-mcp:<id>`, with
  `controlMcpActionAllowed` checked against the credential's *current*
  policy. A revoked credential, or one no longer granted the action, pauses
  the schedule with `authority-lost`.
- **Agent** (agent tools MCP): the owner is the agent's mailbox tab,
  resolved exactly as `send_message` resolves its sender. A fire calls the
  agent's own tool in-process with the scope the HTTP endpoint would have
  authenticated for that tab, including its mail rate limits. Agents cannot
  schedule prompts or launches because they cannot perform them directly.
- **Coordinator** (Control MCP coordinator credential): a fire rebuilds the
  coordinator scope from the stored workspace — the current main
  conversation for a main schedule, the creating side conversation for a
  side schedule — with that role's capabilities, revalidates it like a
  request (`coordinatorInvoker`), and calls the coordinator's own tool
  in-process. Project, environment and project-home checks, the denied
  command list and node routing are the tool's own; coordinator read-only
  rules therefore still apply. A side agent can schedule only what it can
  call: mail and reminders.

At creation the executor refuses what the owner could not run directly
(`ScheduleAuthorityError`): a tool the owner's server does not list, a read,
a schedule tool, an ungranted public action, input the action's own parser
refuses. The fire-time check is the authoritative one.

Owners see and manage only their own schedules: a credential its own, an
agent its environment's (sibling tabs already share the environment), a
side agent its own, the main coordinator all of its coordinator's. The
operator sees and manages every schedule, and may retime, pause, resume, run
or delete any of them, but only the owner can change a schedule's action,
since it always runs as the owner.

### When the owner or the target goes away

| Event | Effect |
| --- | --- |
| Environment deleted | Its agents' schedules are **deleted**; other owners' schedules whose action targets it are **paused** (`target-deleted`) |
| Agent mailbox tab removed | The next fire pauses its schedules (`authority-lost`); revoking a session credential alone leaves durable schedules intact |
| Side coordinator conversation closed | Its schedules are **deleted** |
| Main coordinator conversation closed | Nothing: main schedules follow the next main |
| Project removed | Its coordinator's schedules are deleted; schedules launching into it pause |
| Control MCP credential revoked | The next fire pauses the schedule (`authority-lost`) |
| Target missing at fire time (an operator or credential prompt or mail answered `not-found`) | The fire fails and the schedule pauses (`target-deleted`) |

## Surfaces

- **Agents** (agent tools MCP, when messaging is enabled):
  `create_schedule`, `list_schedules`, `cancel_schedule`. Not on the bridges'
  auto-approve lists, so they follow the environment's approval policy.
- **Coordinators** (Control MCP): the same three tools, under the new
  coordinator capability `schedules`, granted to the main and side roles
  (`coordinatorRoleCapabilities`) and listed in
  `COORDINATOR_CONTROL_TOOL_NAMES` so Pi and OpenCode admit them.
- **Operator MCP credentials**: the public actions below, as direct tools
  (`schedule_create`, …) and through `run_action`, under the new
  `schedules` capability (in `full` and `read-only`, not in `voice`).
- **CLI**: `orkestrator schedule list | get | create | update | pause |
  resume | run | delete` ([public-cli.md](public-cli.md#command-surface)).
- **UI**: Settings → Schedules lists every schedule with its owner, when it
  fires next (in its zone), its state and last outcome; creates and edits
  (with a client-side preview of the next three fires), pauses, resumes, runs
  now, shows history and deletes. It reads `list_scheduled_jobs` on mount, on
  every `scheduled-job` resource change and on view safety checks.

The tool form takes `everyMinutes`; the public action takes `everySeconds`.
Agent schedule tools also accept a caller `tabId`, required when an
environment credential has several pull-capable mailboxes. A tab credential
cannot claim another tab.

```text
create_schedule {
  requestId: "wake-0312",
  at: "03:12",
  action: { type: "send_message", toEnvironmentId: "coordinator",
            body: "Usage window reset: resume the stalled workers." }
}
```

## Decisions

Each decision lists the options, the choice and its trade-offs.

1. **Where schedules live.** Options: a store on the `StorageService` chain;
   an engine store reached through `database.rows()` like usage history; a
   SQL table with a migration. **Chosen: an engine `record` store
   (`scheduled-jobs`), one row per schedule, written only with
   `updateStoreRow`.** Single-row transactions are exactly the claim
   primitive exactly-once needs, need no migration, and keep the
   whole-value/transactional writer rule trivially true. Cons: listing reads
   every row (fine at the 1 000-schedule bound); the writer-guard test does
   not parse engine stores, so the rule is upheld by having one write path.
2. **Who fires.** Options: every backend sharing the data directory; a new
   scheduler lease; the existing registry writer lease. **Chosen: the
   registry writer lease, with transactional claims underneath.** It is the
   repository's single-writer guard already; the claim transaction covers a
   lease handover. Con: a non-writer backend's edits wait for the writer's
   next tick (≤ 30 s).
3. **Missed fires.** Options: always run every missed fire; always skip;
   run once if within a window. **Chosen: coalesce to the latest slot, run it
   once if within `catchUpMinutes` (default 15, floor 1 minute), else record
   a skip.** Pros: no thundering herd after downtime, the 03:12 wake still
   arrives after a short outage, every decision is visible in history. Con:
   long outages skip work by design; a schedule that must always run sets a
   large window.
4. **Cron and DST maths.** Options: a library (croner, cron-parser);
   `Temporal` (available in Bun 1.4 but not in the repository's TypeScript
   `lib` or the renderer); a small `Intl` implementation. **Chosen: our own
   `Intl`-based module with `Temporal`'s `compatible` rules.** Pros: no
   dependency or lockfile churn, runs in backend, CLI and renderer, the DST
   semantics are ours and tested. Con: we maintain a cron parser
   (five fields; no seconds, `L`, `W` or `#`).
5. **Fire identity and idempotency.** Options: random fire ids; slot-derived
   ids. **Chosen: `<schedule>@<slot ms>` and dispatch key `sched:<fireId>`.**
   The same slot always has the same id, so a re-claimed fire replays rather
   than repeats through every existing idempotency store. Con: ids reveal the
   slot time (not sensitive).
6. **"Succeeded".** Options: wait for a launched turn or prompt to finish;
   record acceptance. **Chosen: acceptance**, with the operation id recorded
   for `run get`. A scheduler holding fires open for hours would block the
   next slot and duplicate the public run observer. Con: a turn that later
   fails still shows a succeeded fire.
7. **How agents' and coordinators' actions run.** Options: re-implement
   their permissions for the scheduler; dispatch public actions under a new
   authority; call their own MCP tools in-process with their own scope.
   **Chosen: their own tools, in-process.** Nothing can be scheduled that
   the owner could not do directly, every boundary check is the existing one,
   node routing works unchanged, and the public-action authority set stays
   `operator | control-mcp:<id>`. Con: a fire builds an MCP server per call
   (cheap; schedules fire rarely).
8. **Coordinator owner identity.** Options: the conversation; the project's
   coordinator. **Chosen: main schedules belong to the coordinator and run
   as the current main; side schedules belong to their conversation.** This
   mirrors how open delegations move to the next main, so "wake me at 03:12"
   survives the user swapping the main's provider. Con: a main schedule may
   wake a different agent than the one that created it (by design, the same
   as worker reports).
9. **Reminders to oneself.** Options: forbid them (mail to one's own mailbox
   is refused); a new mail source; a system notice with the existing
   `workflow` source. **Chosen: a system notice with `source: "workflow"`
   and `resourceId` = the schedule id.** It reuses the wake path status
   notices use, needs no protocol change in bridges and the renderer, and can
   only reach the owner's own mailbox. Con: in the inbox it looks like a
   workflow notice; the subject ("Scheduled reminder: …") and the `sch_`
   resource id tell them apart.
10. **Deleting an owner: pause or remove.** **Chosen: remove the schedules an
    environment's agents or a closed side conversation own; pause other
    owners' schedules that target a deleted environment or project.** The
    owner's authority (tab, mailbox, credential) cannot be re-established,
    so a paused schedule could never run again, and environment deletion
    already removes everything environment-scoped, prompt text included.
    Schedules owned by someone else are paused instead, because their owner
    still exists and should decide. Con: an agent's schedule history goes
    with its environment.
11. **Revoked credentials.** Options: delete; pause at revocation; pause at
    the next fire. **Chosen: pause at the next fire (`authority-lost`).**
    The fire-time check is required anyway and keeps the credential store
    free of scheduler hooks. Con: the paused state appears only when the
    schedule would have fired.
12. **What may not be scheduled.** Reads, `schedule.*` and the schedule
    tools, and actions that always need confirmation. Pros: no recursion, no
    unconfirmable destructive actions. Con: a nightly `environment.delete`
    must be done another way.
13. **Busy targets.** Options: fail at once; queue in the session; retry.
    **Chosen: retry every 30 s for 15 minutes.** `session.prompt` refuses a
    busy session rather than queueing; a scheduled prompt at 03:12 should not
    fail because a turn was still finishing. Con: a fire may land up to 15
    minutes late (recorded as attempts).
14. **CLI and MCP parity.** **Chosen: eight `schedule.*` public actions**,
    which give the CLI commands and the operator MCP direct tools through the
    existing parity tests (`command-actions.test.ts`, the direct-tool
    generator). Agent and coordinator surfaces get three tools in their own
    vocabulary (`type: "send_message"`, `everyMinutes`).
15. **UI placement.** Options: a project board tab; a Settings section.
    **Chosen: Settings → Schedules, a command-node section** listing this
    backend's schedules across projects (operator schedules need not belong
    to a project). Con: a leaf node's schedules are managed from that node's
    own window or CLI.

## Limits

1 000 schedules per data directory; 50 per owner other than the operator; 20
fires of history each; action input 64 KiB; prompt 100 000 characters;
intervals 60 s to 366 days; catch-up 0 to 10 080 minutes; at most four fires
executing at once per backend.

## Testing

- `packages/protocol/src/schedule-time.test.ts`: cron parsing, DST gap and
  overlap in London and New York, one-shot forms, performance on a change day.
- `apps/backend/src/core/scheduled-jobs/service.test.ts`: persistence across
  a restart, catch-up within and beyond the window, the tolerance floor,
  re-claiming an abandoned fire, exactly-once claims across two backends on
  one data directory, the writer gate, busy retries, run now, pause and
  resume, bounded history, visibility and lifecycle hooks.
- `apps/backend/src/core/public-api/public-api-schedules.test.ts`: the real
  registry and storage with a scripted provider. A schedule fires each action
  kind (mail, a prompt that waits out a busy session, a launch whose base
  commit is resolved at fire time), `schedule.*` and credential scoping, a
  revoked credential pausing its schedule, and an agent's schedules running
  through its own tools (peer mail and a reminder to itself).
- `apps/backend/src/core/scheduled-jobs/coordinator-schedules.test.ts`: the
  real Control MCP endpoint: a coordinator's "wake me at 03:12", a scheduled
  launch through its own `launch_environment`, side-agent refusal, listing
  and cancelling.
- `apps/web/src/components/settings/SchedulesSettings.test.tsx`: the
  settings list, actions, create/edit dialog and history.
