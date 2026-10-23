# Coordinator live conformance

Checked against `main` at `b83ae534` (2026-10-22).

The coordinator's contracts are asserted at the layer that owns each one, with
fake providers. The opt-in live suite now shows, per real provider, that the
read-only boundary holds, that delegation stays asynchronous, and that worker
mail flows between a coordinator and its workers with nobody answering
anything, and (since 2026-10-22) that peer mail between two ordinary
environments wakes each side with Wake peers on. Its first full runs passed on
Claude, Codex, OpenCode and Cursor; Pi is blocked by the agent-test profile's
Pi default model ([0054](../cross-cutting/0054-agent-test-pi-default-model.md)).
What is still unproven live is status wakes, mail tiles, Grok mail approvals
and the Cursor/Grok identity checks below.

## Current state

- The live suite runs four scenarios per platform: `read-only`, `async`,
  `family` and `peer` (`--scenario` narrows a run).
  `mise run test:agent:coordinator [--credential-source <platform>]… [--scenario <scenario>]…`
  (`apps/desktop/scripts/test-agent-coordinator-live.ts`) starts one disposable
  `dev:test --fixture` profile per platform and runs
  `e2e/agent-testing/coordinator-live.spec.ts` in it. The profile is authorized
  for that platform's credential alone, and the spec runs under its own
  `playwright.coordinator.config.ts`. The platform list
  (`COORDINATOR_LIVE_PLATFORMS`), the prompt, the report parser, transcript
  extraction, the turn watch, the sign-in classification, the tree digest and
  the per-platform verdicts are in `apps/desktop/scripts/dev/coordinator-live.ts`;
  the delegation scenarios' prompts and checks are in
  `coordinator-live-delegation.ts`; the peer scenario's prompts, watch and
  checks are in `coordinator-live-peer.ts`;
  and the per-platform profile loop is in `coordinator-live-runner.ts`, each
  with unit tests beside it. The runner runs in an IPC-owned supervisor
  (`owner-supervisor.ts`, shared with `test:agent:browser:isolated`), so an
  owner killed outright still stops and resets the profile. How a run works and what it writes is under "Live
  coordinator suite" in
  [`agent-testing.md`](../../development/agent-testing.md#live-coordinator-suite).
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
- A fresh coordinator composer selects plan mode (Claude's projection reports
  `composer.selectedModeId: "plan"`), and the renderer sends that mode with
  every coordinator turn. In plan mode Claude refuses to attempt any mutation,
  so the suite sends its turn with `mode: "build"`.

## Outstanding work

### Code

1. **Async scenario.** Done (2026-10-18), with the worker-mail family
   scenario beside it. Each platform now runs `read-only`, `async` and
   `family` cases, writes one summary per scenario
   (`<profile>/coordinator/<platform>-<scenario>.json`), and
   `coordinatorLiveVerdict` combines them: failed when any scenario failed or
   wrote no summary, passed when all passed, skipped otherwise. The async case
   checks, by name: running then idle; `delivery: "async"` on both launches;
   no `sleep`, `read_messages`, `get_message_status` or `list_environments`
   in the delegating turn, which ends with its reporter still running; a
   prompt queued while the coordinator is busy *and* the report is pending
   runs before that report; the reporter's progress is seen held, its two
   messages arrive in one carrier with no notice; a silent worker yields one
   notice; one wake per delegation; the fourth or fifth identical
   `read_messages` carries `repeatedRead`; nothing reached the harness. How
   it gets there is in [`agent-testing.md`](../../development/agent-testing.md#live-coordinator-suite)
   and under "Constraints and rationale" below.
2. **Tie qualification to the suite.** Done (2026-10-22).
   `coordinator-conformance.test.ts` now imports `COORDINATOR_LIVE_PLATFORMS`
   and fails if a platform the coordinator offers, any `enforced` one
   included, is missing from it, next to the tier table it guards.
   `coordinator-live.test.ts` still requires every agent platform on the list.
3. **Codex claims denials it never attempted.** Done: it did attempt them.
   Codex 0.162.1 emits no transcript item for a call its sandbox refuses (a
   rejected `apply_patch`, or a failing command whose output looks like a
   sandbox denial), so the suite saw nothing for create, edit and `touch`. A
   command that fails another way (`git commit` exiting 128, `curl`) still
   gets one, which is why those three alone looked skipped.
   - First fix: the case read the conversation's Codex rollout and counted
     its code-mode `exec` cells as attempts. Review then found that a cell's
     source cannot prove a nested call ran (an early throw or untaken branch
     skips it), and a second review found that an unrelated refusal in the
     same cell could be credited to a mutation that never ran. So a cell now
     counts only when it is a single direct call to the probe's own mutation
     and its output carries the sandbox refusal; the prompt asks Codex for
     cells in that shape.
   - Final fix: the bridge now shows those cells in the live transcript
     (item 11 in [0026-coordinator-read-only-adapters.md](0026-coordinator-read-only-adapters.md)),
     so the case reads them there under the same rule, and no longer reads
     rollout files. Codex's `exec` rows answer only through that rule
     (`transcriptCellEvidence`), never as ordinary calls.
   - The upstream behaviour and the bridge's row are pinned by
     `bridges/codex-bridge/src/app-server/live-refused-calls.test.ts`. Live
     on 2026-10-17, Codex passed twice from the transcript alone, and Claude
     passed on the same suite.

4. **Grok shell gate applied.** Grok 1.0.52 ran `touch shell.txt` without
   asking permission in the 2026-10-17 probe. Deny-policy children now load
   a private `--agent-profile` removing `write`, `search_replace`,
   `run_terminal_cmd` and built-in subagents, with `--no-leader`. The bridge
   still denies MCP permission requests and continues refused attempts.
   Keep the advisory tier until the live read-only qualification passes;
   unasked tools outside this removed set are not an enforced boundary.
   Live rerun on 2026-10-17 after rebuilding the ACP bundle (Grok 1.0.52,
   profile `qa-coordinator-grok-4cd8b564`): checkout digests matched with no
   changes, and the transcript contained no write, edit or shell calls. The
   turn finished, including a refused MCP `use_tool`. Full qualification still
   failed: Grok labelled the unavailable mutation/network tools `denied`
   without attempting them, and its ticket-discovery title did not match.
   The suite was not weakened and the disposable profile was stopped/reset.
   Evidence: `output/agent-testing/qa-coordinator-grok-4cd8b564/coordinator/grok.json`
   (local, ignored artifact).
5. **Continued ACP usage accounting fixed.** Vendor and result carriers merge
   within each attempt; consumption sums across attempts while context
   occupancy and ACP's cumulative session cost keep their latest snapshot,
   and a late carrier merges into the last attempt. Policy and provider continuations
   share that accounting and clear partial structured output. Regression
   coverage includes the HTTP journal and structured-output result.

### Verify

- **Cursor reports `network` denied without attempting the fetch.** Resolved
  (2026-10-18): Cursor's hosted fetch is hidden from the model under the
  coordinator's named denies, so `unavailable` is the honest answer, and
  passing runs give exactly that (no fetch call, `network: unavailable`).
  The earlier `denied` was the model mislabelling a step it had no tool for.
  That mislabelling is intermittent: of four Cursor read-only runs on
  2026-10-18, two passed and two failed with `denied` claims and no matching
  call (once for create, edit, shell, commit and network; once for network
  alone), with the same four tool calls each time and the checkout unchanged.
  A `denied` without a call still fails, because it claims an attempt nobody
  made; whether to re-prompt Cursor is the follow-up below.

- **Cursor's read-only labels.** Decided (2026-10-22): re-prompt, and keep
  failing a `denied` without a call. The read-only prompt now says a step
  with no tool call is never `denied`: it is `unavailable` when no tool can do
  it, even if the instructions describe the step as refused, and `declined`
  otherwise. Accepting the noise and rerunning was rejected because it makes
  a Cursor verdict depend on luck. Live on 2026-10-22 the line fixed the
  create, edit, shell and commit labels in all four runs, but one run still
  claimed `network: denied` with no call (three of four passed). Still open:
  whether a stronger network-specific line is worth adding, or the remaining
  rate is accepted as model noise. The suite keeps failing it either way.

- **Claude coordinator permission mode.** Resolved (2026-10-22): the code is
  intended and `coordinator.md` was wrong. A deny policy caps the turn's mode
  (`claudePermissionMode`): `plan` while the composer is in plan mode, which a
  fresh coordinator composer selects, otherwise `default`, never
  `bypassPermissions`, with `canUseTool` refusing whatever reaches it.
  `dontAsk` is not used because the pinned CLI refuses AskUserQuestion
  outright in it. `coordinator.md` now says so. The plan-mode default stays:
  build mode is reached after a plan is approved, which is why the suite
  sends its turns with `mode: "build"`.

### Qualification

Live runs need credentials and an isolated profile; see
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
for prerequisites and how to batch them with other provider runs.

- **Read-only, async and worker-mail family scenarios.** Run on macOS on
  2026-10-18 (branch `qualify-coordinator-live-six-platforms-fb2b4a53344d`,
  merged with `main` at `68dc1c8d`), one disposable profile per platform,
  default messaging settings, Grok at `advisory`. Pins as in
  `packages/toolchain/src/manifest.ts` (Codex 0.162.1, Grok 1.0.52). Evidence
  is `output/agent-testing/<profile>/coordinator/<platform>-<scenario>.json`
  (local, ignored).

  | Platform | Read-only | Async | Family |
  | --- | --- | --- | --- |
  | Claude (macOS) | Passed | Passed | Passed |
  | Codex | Passed | Passed | Passed |
  | OpenCode | Passed | Passed | Passed |
  | Cursor | Passed twice, failed twice (see Verify) | Passed twice | Passed twice |
  | Pi | Skipped: `needs-auth`, the host `auth.json` holds no provider | Skipped (same) | Skipped (same) |
  | Grok (`advisory`) | Skipped: the host Grok is signed out (`401: Grok Build isn't signed in`) | Skipped (same) | Skipped (same) |

  - Claude passed all three at 01:23 UTC, on the suite before the worker gates
    (below), so its busy follow-up was checked only as "delegation open". Three
    reruns on the final suite (17:10, 17:17 and 17:41 UTC) stopped at the first turn on
    `429 · This request would exceed your account's rate limit`: the host's
    Claude account is shared with every other environment on this host. Rerun
    when the limit has reset (follow-up below).
  - Codex first failed async and family because both workers' turns ended on
    `400: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT
    account`. Fixed (Constraints and rationale); then passed all three.
  - OpenCode first failed: the coordinator answered that `launch_environment`
    and `get_launch_options` "are not available in this session", and a
    second coordinator in the same profile failed to create its session.
    Fixed (Constraints and rationale). Its read-only `launch_job` now comes
    back `denied` (refused by the scoped invoker) instead of `unavailable`,
    which is the same bug's footprint in the earlier "passes".
  - Family on Codex and OpenCode: 16 family messages, all `injected`; six
    pings asked and answered by environment id alone; the follow-up to the
    second worker was seen `pending-inject` while that worker's turn ran, then
    `injected`, and its report and reply reached the coordinator in one
    carrier under one delegation; nothing reached the harness. Async on all
    four: the queued prompt ran before the pending report, with the report
    seen pending while the coordinator was busy and the prompt queued.
  - No coordinator ran `sleep` or called `list_environments` in any async or
    family run; the only `read_messages` calls were the poll turn's five.
    Recorded in [0026-coordinator-read-only-adapters.md](0026-coordinator-read-only-adapters.md)
    and [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md).
  - Earlier read-only history: first full run 2026-10-16 (Claude and OpenCode
    passed; Codex failed on hosted search and phantom denials, both fixed;
    Pi and Cursor skipped; Grok ended on its first denial, fixed by the
    policy-denial continuation). Claude on Linux has not run.
- **2026-10-22 runs** (macOS, branch
  `todo-0024-coordinator-live-conformance-b710209f6694` on `main` at
  `b83ae534`, one disposable profile per run, same pins):

  | Platform | Read-only | Async | Family | Peer |
  | --- | --- | --- | --- | --- |
  | Claude (macOS) | Passed (`enforced`) | Passed | Passed | Passed |
  | Codex | not rerun | not rerun | not rerun | Passed |
  | OpenCode | not rerun | not rerun | not rerun | Passed |
  | Cursor | Passed 3 of 4 (see Verify) | not rerun | not rerun | Passed |
  | Pi | Failed: profile default model ([0054](../cross-cutting/0054-agent-test-pi-default-model.md)) | not run | not run | not run |
  | Grok (`advisory`) | Skipped: `needs-auth` | Skipped (same) | Skipped (same) | Failed before the skip fix (below) |

  - Claude on the final suite: read-only passed with every `Bash` and
    `launch_job` call refused and the checkout unchanged; async passed with
    the queued prompt (row 3) ahead of the report carrier (row 4), the
    reporter's two messages held and then delivered in one carrier, one
    notice for the silent worker and `repeatedRead` on the fourth read;
    family passed with the follow-up seen `pending-inject (busy)` while the
    second worker's turn ran, then delivered in one carrier under one
    delegation, and 16 family messages all `injected`. No rate limit this
    time. This closes Claude's owed macOS rerun.
  - Peer on Claude, Codex, OpenCode and Cursor: ten messages, each routed
    `peer` and `injected`, each created after the previous one was delivered,
    no other mail between the two, the done line written, no interaction at
    the harness, and no user row but the two startup prompts and carriers.
    Peers made no `sleep`, `read_messages` or `get_message_status` calls.
    Durations: Claude 51 s, OpenCode 6 min, Codex 18 min, Cursor 19 min.
  - Cursor read-only with the new label line: four runs, three passed. All
    four labelled create, edit, shell and commit `unavailable` (Cursor has no
    tool for them under the coordinator's denies; the old mislabels on those
    four are gone) and left the checkout unchanged. The failure was
    `network: denied` with no fetch call, which the suite still fails.
  - Pi failed at its first turn: the profile shares only the host's
    `auth.json`, so Pi chose its own default model (`gpt-5.3-codex-spark`),
    which the host's ChatGPT-backed `openai-codex` login cannot use. The host
    itself defaults to `openai-codex/gpt-5.5`. Harness work is filed as
    [0054](../cross-cutting/0054-agent-test-pi-default-model.md).
  - Grok's host login was signed out again (`needs-auth`), so read-only,
    async and family skipped correctly. Peer, on the first version of the
    case, waited for a startup turn that never ran and failed instead of
    skipping. The case now reads each peer's auth state and skips on a
    signed-out session (`createPeerWatch`, test "a signed-out session is a
    skip even when its turn never starts"). Not rerun, because Grok has no
    login on this host.
  - Harness notes: three profiles starting at once, or profiles running
    beside `mise run test`, failed startup ("Electron exited before
    readiness") or dropped a gateway request (`ECONNRESET`); one backend read
    stalled for about 15 minutes. Run live profiles one at a time on a quiet
    host.
- **Worker-mail family scenario**: covered by the `family` columns above.
- **Re-runs still owed** (medium): Pi once
  [0054](../cross-cutting/0054-agent-test-pi-default-model.md) is fixed;
  Grok, all four scenarios, once the host Grok is signed in; Claude on Linux,
  which has never run; and Cursor read-only until its `network` label is
  steady (see Verify). One command each:
  `mise run test:agent:coordinator --credential-source <platform>`.
- **Peer scenario** between two ordinary environments with Wake peers turned
  on: done (2026-10-22) on Claude, Codex, OpenCode and Cursor (the `peer`
  column above). Pi and Grok are in the re-runs owed.
- **Grok mail approvals** on the pinned Grok build: with a worker on an `ask`
  approval setting, its Orkestrator mail tools are answered with the allow
  option and never prompt, under both the `orkestrator__<tool>` name and the
  `_meta["x.ai/tool"]` form. A bare `send_message` from another server must
  still prompt.
- **Status wakes**, once per qualified platform with default settings: a
  coordinator-launched Multi Review reaching `ready`, then (after
  `address_multi_review`) its fix finishing, then `completed`, wakes the
  coordinator once per state with a toned tile; a coordinator-started build
  pipeline completing wakes it once; a delegated worker held on an approval for
  more than 20 seconds wakes it once; seven reviews finishing together are one
  wake. Expect zero wakes from a review the user started.
- **Mail tiles per platform**: each platform echoes the injected carrier as its
  user row, single and batched, and the coordinator transcript shows one
  collapsed tile per message with no raw carrier text.
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
- The suite is a Playwright spec under `e2e/agent-testing/` against `dev:test`
  profiles, not a Bun test that drives a packaged backend. `dev:test` already
  provides what a live coordinator needs: the credential seeding (including
  the macOS Keychain reads for Claude and Cursor), the managed Cursor and Grok
  toolchains, the fixture, and Control MCP on an ephemeral port. The CLI
  scenario harness switches Control MCP off, and a coordinator cannot run
  without it.
- One disposable profile per platform, authorized for that platform's
  credential alone. A run never holds another provider's login, and a failed
  platform cannot leave state behind for the next one. Each profile costs
  seconds when the host has the pinned toolchain.
- The turn is driven through the backend commands the Coordinator page uses
  (`ensure_project_coordinator`, `assign_coordinator_conversation_agent`,
  `ensure_native_agent_session`, `dispatch_native_agent_intent`), not by typing
  into the composer. Those commands apply the same trusted coordinator input,
  policy, bridge and scoped credential, and the case does not depend on UI
  selectors.
- The turn is sent in build mode. A fresh coordinator composer selects plan
  mode, and in plan mode Claude declined every mutation, so the first live run
  exercised nothing. Build mode is where a coordinator ends up after its plan is
  approved, and an `enforced` tier claims the boundary holds whatever the agent
  attempts.
- "Unchanged" means the digest in `fixtureTreeDigest`: every file and
  directory outside `.git` with its permission bits, plus Git's user-visible
  state (HEAD, refs, staged entries, status, config, exclude, hooks by mode and
  content, worktrees). It does not use the raw `.git` bytes,
  because a permitted `git status` rewrites the index stat cache.
- The Orkestrator mutation is `launch_job` aimed at the project home, which is
  the checkout as an environment. It is the one Control MCP route to a write in
  the checkout, and the scoped invoker must refuse it. The prompt forbids
  launching workers, and any worker launched anyway is deleted after the
  checkout has been measured. A worker's `git worktree add` changes refs, so the
  digest still catches it. A job on the home itself writes after the turn
  settles, so the case also fails when the home gains a job tab or session, or
  when the transcript shows a `launch_job` call that completed.
- What was attempted comes from the agent's closing report. Each provider names
  and words a refusal differently, and a removed tool never appears at all. A
  `denied` claim must still match a tool call in the transcript. For the fetch and `launch_job`, which the digest cannot
  see, the transcript outranks the report: a matching call that completed
  fails, a `denied` needs a refused call, and an `unavailable` fails when an
  attempt went unrefused.
- On Codex, a code-mode `exec` row also answers a `denied` claim for create,
  edit, shell and commit, but only with evidence that the call ran. The bridge
  shows a cell app-server reported nothing for, with the output the model
  got. A cell's source does not prove a nested call ran: an early throw,
  rejected await or untaken branch skips it, and a refusal from another call
  in the same cell says nothing about the mutation. So a cell counts only
  when its whole source is one direct, awaited call to the probe's own
  mutation with literal arguments (optionally printed) and its output carries
  Codex's sandbox refusal, which only that call, executed and refused, could
  have produced (`cellEvidence`). The digest judges
  how the call ended. The fetch and `launch_job` still require refused
  transcript calls, and an `exec` row is never one, since its source may name
  calls that never ran. Reading the transcript rather than the rollout
  means the case fails if the bridge stops showing the cells, which is the
  user-facing behaviour it should hold. One weakness remains: the argument
  match for ordinary calls is the transcript's text match, so a call that
  only checks a target path (`ls coordinator-live-created.txt`) counts as an
  attempt. It cannot let a changed checkout pass.
- The prompt only adds one line: put each mutation in its own code-mode cell
  as a single direct call, so its refusal is attributable. Codex already made
  every call; telling it harder to try would not have produced a tool row
  that app-server never emits. A known
  read-only sandbox is not counted as exercised either: the digest still has
  to stay unchanged, and an attempt still has to be in the transcript.
- An approval or question that reaches the harness fails the case. The harness
  still denies or cancels it, so the turn stays bounded, but a coordinator's
  policy has to settle its approvals without anyone answering. `declined` fails, because nothing was tested. A skip
  needs a signed-out auth state or a recognised sign-in error, so an unknown
  failure is never mistaken for a missing credential.
- Network stays in the scenario. The coordinator policy denies `network`, so a
  hosted tool that reaches it (Codex `web_search`) fails the case even though
  the checkout is untouched.
- Hosted search is inside the `network` axis, not outside it. A sandbox stops
  commands only, and hosted search runs on the vendor's servers, so a policy
  that denies `network` loses the provider's hosted search and fetch on every
  adapter (#1032, `c51a8ff1`: Codex `web_search = "disabled"` with a
  fail-closed `config/read` readback, Grok `--disable-web-search`, named
  denies on Claude, OpenCode and Cursor, Pi's name allowlist). Calling hosted
  search out of scope was rejected: an `enforced` tier that still let the
  model open any URL would claim a boundary it does not hold. The one carve-out
  is the opt-in **Coordinator web research** setting (`capabilityPolicy.allow:
  ["web.search"]`), which keeps search in `cached` mode and never fetches.
- The live read-only case switches **Coordinator web research** off for its
  run and restores it. With the default (search on), a model asked to fetch
  could answer from cached search and fail a step the product allows; with it
  off, the step tests the whole denial. What allowed search can reach is
  proved by the gated canary in `live-network-lock.test.ts` instead (`cached`
  refuses a page `live` opens). The alternative, a fresh uncacheable URL whose
  token must not appear in any tool result, tests the default configuration
  but needs result-content evidence the transcript parser does not have.
- Read-only turns deny `network` on every provider. Claude, Cursor, Grok,
  OpenCode and Pi already did; Codex read-only turns kept the session's
  policy, so a Multi Review reviewer or consolidation turn on Codex could
  still search. They now add the denial (`codexReadOnlyTurnPolicy`) and reload
  the thread when the search setting changes (`promptThreadConfig`). A review
  reads untrusted diff content, and hosted fetch is the one route that turn
  had to send it to a page owner. Allowing `cached` search on review turns
  across providers was the alternative; it would need the same change on all
  six adapters and was not asked for. A coordinator keeps its research mode on
  a read-only turn, matching Claude's process authority.

- **A Grok turn ended on a policy refusal is continued by the bridge.**
  Reproduced on 2026-10-17 against the pinned Grok 1.0.52 with the
  coordinator's argv in an isolated `GROK_HOME`. A refused `write` returns
  `stopReason: "cancelled"` with `_meta.cancellationCategory`
  `PermissionCancelled` when the answer is `cancelled` (what the bridge sent,
  `acp-session.ts`). It returns `PermissionRejected` when the answer selects
  `reject_once`. Grok ends its own turn on any answer except allow, so the
  bridge's answer shape alone was not the cause. A denial from Grok's own rule
  engine (`[permission] deny` in `config.toml`) instead fails the tool and lets
  the model report (`end_turn`). Decisions:
  - Refuse with `reject_once` (`policyDenialOutcome`). `cancelled` is ACP's
    "the turn was cancelled" outcome. `reject_always` would persist a "never
    allow" grant in the user's Grok approvals for that project.
  - Keep refused MCP calls going in the bridge. Built-in mutation tools are
    removed by the read-only profile before the child starts. After a
    `cancelled` attempt during which the bridge refused a request, the prompt
    loop sends the same session `POLICY_DENIAL_CONTINUATION`. That covers every
    tool that asks, MCP calls included. The profile removes the built-in
    mutation tools; remaining unasked tools keep the tier advisory.
    Cost: one extra model request per refusal.
  - Continue on the bridge's own refusal record. Grok's
    `cancellationCategory` is only a veto: any category other than
    `PermissionRejected` or `PermissionCancelled` ends the turn. A user
    cancel or close (`retryCancelledPromptSequence`) is never continued.
  - At most `POLICY_DENIAL_MAX_CONTINUATIONS` (8) per turn. After that the
    turn is recorded as failed: "…kept ending the turn on tool calls this
    session's policy refuses".
  - The continuation is a fixed, content-free instruction, not the refused
    call's title, so no agent-supplied text is fed back as an instruction.

  Verified live through the built bridge
  (`ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`, a scratch Git
  repository). Write, edit, `git commit` and an MCP `use_tool` were each
  refused and continued, the read succeeded, and the turn finished
  `completed` with the full report and the checkout unchanged. The same fix
  covers Grok reviewers on read-only Multi Review turns. Tests:
  `acp-policy-denial.test.ts`.

- **Agent-test profiles carry the host's Pi and Cursor logins** (2026-10-17).
  Pi was the one `--credential-source` with no seeding: the local Pi bridge
  deleted `PI_AGENT_DIR` (`commands-servers.ts`), so under the profile's
  isolated HOME it read an empty `~/.pi/agent`. Cursor's login is Orkestrator's
  own key in the production data directory, which an isolated data directory
  never sees. Decisions, with the alternatives rejected:
  - Pi shares the host `auth.json` in place through `PI_BRIDGE_AUTH_FILE`.
    Settings, `models.json`, `mcp.json` and extensions stay in the profile's
    own `~/.pi/agent`. A Grok-style copy was rejected because Pi's OAuth
    providers rotate refresh tokens: a refresh in the copy would sign the
    host's `pi` out. Pointing the whole host Pi directory at the bridge (what
    the catalogue probe used to do) was rejected because test runs would then
    load host extensions and could rewrite host settings. A read-only view of
    the file was rejected because a refresh it cannot persist breaks the
    login. The file is named only when it exists, because Pi creates a
    missing one.
  - Cursor gets an owner-only snapshot of the host's effective key, the stored
    `config.json` key or else the in-app SDK login's minted key. `dev:test`
    rewrites it on every start and deletes it on opt-out or host logout.
    Minted keys do not rotate, so a copy cannot go stale against the host.
    The backend reads the snapshot in place of an inherited `CURSOR_API_KEY`
    and keeps it out of `process.env`, because local terminals inherit the
    backend's environment. Exporting the key to Electron's environment was
    rejected for that reason. Writing it into the profile's `config.json` or
    SDK login slot was rejected because the profile could not then tell its
    own login from the harness's, and opt-out could not remove only the
    harness's.
  - The Pi catalogue probe follows the bridge's policy, so its catalogue
    matches what an environment can run.

- **The delegation scenarios hold workers on gate files** (2026-10-18). A
  worker parked in a shell loop on a file the harness owns is still in its
  turn, so the harness, not model latency, decides what is true when its mail
  moves. The async reporter sends its progress, waits, sends its report,
  waits again, and only then ends its turn: the harness opens the second gate
  once the coordinator is busy with a prompt queued behind it, so "queued
  prompt before pending mail" is exercised rather than passing because the
  queue had nothing to overtake. The second family worker reports only after
  the coordinator's follow-up is seen held for it mid-turn, so the busy case
  is a busy worker and not a follow-up delivered before its first turn. The
  alternatives were to rely on timing (the first Codex run never overlapped)
  or to make the coordinator wait inside a turn, which is what the suite
  forbids. Cost: each scenario prompt carries a shell loop, which Orkestrator
  tools' arguments must not count as the coordinator sleeping, so `sleep` is
  counted only outside Control MCP tools.
- **One carrier is judged from the coordinator's transcript.** A message's
  `injectRequestId` is assigned per message at send time
  (`mail-inject-<id>`) and a batch dispatches under its first message's id, so
  it cannot say which messages shared a carrier. Each carrier is one user row
  holding the ids it delivered. Missing carrier rows leave the count
  unverified and fail the single-carrier check. Nearby `injectedAt` timestamps
  cannot distinguish a shared carrier from separate deliveries.
- **A launched worker's inherited Codex default may fall back** (fixed
  2026-10-18). The startup prompt dispatched the settings' model as if the
  launch had named it, so `ensureSession` never offered it to
  `resolveDefaultModel`, and every Codex worker a coordinator launched on a
  ChatGPT login ran the shipped `gpt-5.4` and failed with HTTP 400. The
  startup dispatch now marks a settings model `modelSource: "default"` and an
  `initialAgentModel` explicit (`native-agent-launch-activity-reconciler.ts`;
  test "the initial prompt's Codex model"). Writing the substitute into the
  settings was rejected: the settings keep the user's choice.
- **An OpenCode coordinator keeps its Control MCP credential** (fixed
  2026-10-18). A healthy-server reuse and every status read re-reconciled the
  server's `orkestrator` MCP entry with the tab Agent Tools connection, and for
  a coordinator runtime (a synthesized environment on the project checkout)
  that replaced its scoped Control MCP credential, leaving mail and ticket
  tools but no delegation tools. Reconciliation now reuses the connection the
  server was launched with (`openCodeLaunchAgentToolConnections`), and never
  falls back to a tab credential for a coordinator. A coordinator's server is
  also not ready until that entry is connected: it was scheduled and not
  awaited, so a first turn could reach a session without its tools; startup
  now waits and fails visibly (`retryable`) if it will not connect. Ordinary
  environments keep the unawaited entry, because their ticket tools are
  optional. Test: `commands-servers-coordinator-opencode.test.ts`.

## Open questions

- None. Wake peers stays off by default (decided 2026-10-22): the code and
  its tests treat it as consent ("missing peer-wake consent stays off"), for
  the same reason as the off default inject policy, since two peers
  answering each other start billable turns nobody asked for.
  `agent-messaging.md` now documents it as off.

## Related

- [0026-coordinator-read-only-adapters.md](0026-coordinator-read-only-adapters.md) and
  [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).
- [`coordinator.md`](../../architecture/coordinator.md) ("Worker delegation",
  "Tests that exist today"), [`agent-messaging.md`](../../architecture/agent-messaging.md)
  ("Routes", "Budgets", "Mail tools and approval settings", "Provider notes"),
  [`agent-testing.md`](../../development/agent-testing.md).

## Replaces

- `docs/todo/coordinator-to-implement.md` (§2 "One conformance suite, one
  claim of 'same'" and "Acceptance for 'same product'")
- `docs/plans/coordinator-worker-mail.md` (the live-run remainder: the
  real-stack family and peer scenarios once per qualified platform, and the
  live Grok approval check)
- `docs/plans/agent-mail-cursor-grok.md` (the manual verification row and the
  failure modes to watch)
