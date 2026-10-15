# Coordinator live conformance

Checked against `main` at `2459b05c` (2026-10-15).

The coordinator's contracts are asserted at the layer that owns each one, with
fake providers. What no test shows yet is that real providers keep them: that
the read-only boundary holds against a real model, that delegation stays
asynchronous, and that worker and peer mail wake their recipients with no user
action on every qualified platform. This file covers one opt-in real-provider
suite and the live runs it enables. Apart from the suite itself, all of it is
qualification.

## Current state

- No live coordinator suite exists. There is no `tests/agent/` directory, and
  nothing in `e2e/agent-testing/` drives a coordinator turn on a real provider
  (`browser-gateway.spec.ts` exercises coordinator Multi Review actions through
  backend commands only).
- The cheap halves, all in `apps/backend/src/core/` unless noted:
  - `coordinator-conformance.test.ts`: the policy names capabilities, the
    `enforced` set is exactly `claude`, `codex`, `pi`, every platform has
    `delegation`, Claude has no waiting tools, one async contract string;
  - `coordinator-providers.test.ts`: tiers, the safety-level setting, host
    probe, delegation derived from the mail round trip;
  - `native-agent-service-reconciliation.test.ts` (presence and the turn-end
    edge), `coordinator-service.test.ts` (one wake per delegation, crash
    recovery), `agent-mail-service.test.ts` (one carrier per drain),
    `control-mcp-server.test.ts` (tool contract and poll guard);
  - `agent-mail-scenarios.test.ts` on `agent-mail-world-test-support.ts`:
    multi-actor, in-process scenarios for two workers reporting, a silent
    worker, a follow-up by environment id, a ten-message peer conversation, a
    follow-up to a busy worker joining its delegation, stopped workers, a main
    closed mid-delegation, and a backend restart;
  - `agent-tools.test.ts`: a tab-scoped credential resolves as
    `resolved: "credential"`, not `"unique"`;
  - per-bridge policy and activity tests.
- Facts the live scenarios depend on:
  - `launch_environment` returns `delivery: "async"` (`control-mcp-server.ts`).
  - The poll guard (`coordinatorPollGuard`) allows `COORDINATOR_POLL_BUDGET`
    (3) unchanged reads of `read_messages` or `get_message_status` per
    `COORDINATOR_POLL_WINDOW_MS` (120 s). The fourth identical read returns
    `repeatedRead` with `COORDINATOR_ASYNC_CONTRACT`.
  - Mail defaults (`DEFAULT_AGENT_MESSAGING_SETTINGS` in
    `packages/protocol/src/agent-mail.ts`): `defaultInjectPolicy: "off"`,
    `wakePeers: false`, `autonomousWakeBudget` 16, `hourlyWakeLimit` 40.
    Coordinator-route mail wakes under these defaults; peer mail wakes only
    after **Settings → Messaging → Wake peers** is turned on.
  - The Grok approval matcher (`bridges/acp-bridge/src/acp-session.ts`)
    allows a mail tool named `orkestrator__<tool>` or carrying
    `_meta["x.ai/tool"]` with namespace `orkestrator`. It was checked against
    Grok 1.0.46 naming; the pin is now 1.0.52
    (`packages/toolchain/src/manifest.ts`).
- Opt-in patterns to copy: `mise run test:agent:docker` (an environment gate
  plus a title grep), `mise run verify:opencode:live` (`*.live.test.ts` files
  behind `RUN_LIVE_OPENCODE_COMPATIBILITY=1`), and isolated profiles from
  `mise run dev:test --profile <name> --fixture --credential-source <name>`.

## Outstanding work

### Code

1. **Add the suite.** Opt-in, skipped by default, run through a new task (for
   example a `test:agent:coordinator` task in `mise.toml`) and narrowed with
   `--credential-source <name>`. The original proposal was
   `tests/agent/coordinator-read-only.test.ts`; see "Open questions" for where
   it should live. For each platform in the qualification table, it creates a
   coordinator conversation on the fixture project and assigns the platform.
2. **Read-only scenario.**
   1. Hash the fixture tree.
   2. Send one prompt that asks the agent, in order, to create a file, edit an
      existing file, run a writing shell command, fetch a URL, and then call
      the Control MCP discovery tool.
   3. Assert that the tree hash is unchanged, that the transcript shows each
      mutation denied, and that discovery returned.
3. **Async scenario** (for every platform with `delegation`):
   1. A coordinator prompt reports running, then idle.
   2. `launch_environment` returns `delivery: "async"` before any worker
      activity.
   3. A user prompt queued while the coordinator is running is dispatched
      before pending mail.
   4. Two mid-turn worker messages stay held; `working → idle` injects one
      carrier and no system notice.
   5. A silent worker produces exactly one system notice.
   6. Four identical `read_messages` calls return the page with `repeatedRead`.
4. **Tie qualification to the suite.** Extend `coordinator-providers.test.ts`
   or `coordinator-conformance.test.ts` so that every `enforced` platform must
   also be on the live suite's platform list. A platform may not move to
   `enforced` without both a translation and a live entry.

### Qualification

Live runs need credentials and an isolated profile; see
[live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)
for prerequisites and how to batch them with other provider runs.

- **Read-only and async scenarios** on Claude (macOS and Linux), Codex, Pi,
  OpenCode and Cursor, and on Grok with the safety level set to admit
  `advisory`. Record whether Codex reaches for `sleep` and whether any
  coordinator polls `list_environments`; both feed decisions in
  [coordinator-read-only-adapters.md](coordinator-read-only-adapters.md) and
  [coordinator-consistency-gaps.md](coordinator-consistency-gaps.md).
- **Worker-mail family scenario**, once per qualified platform, with default
  messaging settings. Launch two workers; both report; the coordinator follows
  up with one by environment id; that worker replies; ten more alternating
  messages follow. Expect zero user actions and no `stored` or
  `inject_failed` placements in the family. Include one follow-up sent while
  the worker is busy, which must join its open delegation and produce one wake.
- **Peer scenario** between two ordinary environments with Wake peers turned
  on: ten alternating messages and zero user actions.
- **Grok mail approvals** on the pinned Grok build: with a worker on an `ask`
  approval setting, its Orkestrator mail tools are answered with the allow
  option and never prompt, under both the `orkestrator__<tool>` name and the
  `_meta["x.ai/tool"]` form. A bare `send_message` from another server must
  still prompt.
- **Cursor and Grok mailbox identity:**
  - two tabs in one environment each see themselves as `self` in
    `list_mailboxes`;
  - with policy `idle`, an injected user message starts a turn;
  - a Cursor or Grok coordinator can `launch_environment` and is woken by the
    worker's reply;
  - a Cursor resume with a new `agentMcp` detaches and resumes the same SDK
    agent rather than creating a second one that orphans the conversation;
  - a rotated Grok tab token reloads only that session's CLI child and never
    reaches process environment or a sibling session.

### Acceptance for the unified level

A platform is at the unified level when:

- its qualification `delegation` is true;
- the live read-only run leaves the fixture tree unchanged and still reaches
  Control MCP discovery;
- the live async run (if `delegation` is true) produces one wake per
  delegation and never a wait inside the turn;
- its caveats, if any, are on the qualification `reason` and visible in the
  picker before the first send.

Until then, the tier table under "Provider qualification" in `coordinator.md`
is the truth, and this file is the backlog.

## Constraints and rationale

- The async scenario is worth running against real providers, but it does not
  replace the layer tests. Presence, one wake per delegation, batching and the
  poll guard are provider-neutral and stay owned by those tests.
- Mid-turn worker mail stays held until the worker's turn ends. A worker that
  needs an answer sends its question and ends its turn, which wakes the
  coordinator at once. No delegation-age timer.
- Routes as decided: coordinator ↔ the workers it launched wake; peer ↔ peer
  wakes while Wake peers is on; sibling workers, worker ↔ peer and worker ↔
  another coordinator are stored without a wake (`isolated-route`). Mail to a
  stopped local worker starts it; a stopped container is never started behind
  the user's back.
- Use only the seeded fixture project and synthetic prompts, never this
  repository or a real checkout. A provider without credentials is recorded as
  skipped, not passed.

## Open questions

- Where should the suite live? A Bun test under a new `tests/agent/` root that
  drives a packaged backend directly, or a Playwright spec under
  `e2e/agent-testing/` against a `dev:test` profile like the other opt-in live
  specs? The second reuses the existing profile and credential plumbing.
- Should Wake peers stay off by default? The code and its tests treat it as
  consent ("missing peer-wake consent stays off"), while `agent-messaging.md`
  documents it as on.

## Related

- [coordinator-read-only-adapters.md](coordinator-read-only-adapters.md) and
  [coordinator-consistency-gaps.md](coordinator-consistency-gaps.md).
- [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).
- [`coordinator.md`](../architecture/coordinator.md) ("Worker delegation",
  "Tests that exist today"), [`agent-messaging.md`](../architecture/agent-messaging.md)
  ("Routes", "Budgets", "Mail tools and approval settings", "Provider notes"),
  [`agent-testing.md`](../development/agent-testing.md).
- Living-doc drift to fix: `agent-messaging.md` says Wake peers is on by
  default (the `peer` row under "Routes" and `wakePeers: true` under "Settings
  that apply to every provider"), but `DEFAULT_AGENT_MESSAGING_SETTINGS` has
  `wakePeers: false`. The "Tests that exist today" section of `coordinator.md`
  still links `docs/todo/coordinator-to-implement.md` for the live suite gap;
  it should point here.

## Replaces

- `docs/todo/coordinator-to-implement.md` (§2 "One conformance suite, one
  claim of 'same'" and "Acceptance for 'same product'")
- `docs/plans/coordinator-worker-mail.md` (the live-run remainder: the
  real-stack family and peer scenarios once per qualified platform, and the
  live Grok approval check)
- `docs/plans/agent-mail-cursor-grok.md` (the manual verification row and the
  failure modes to watch)
