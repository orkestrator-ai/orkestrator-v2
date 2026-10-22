# MCP management

Checked against `main` at `2459b05c` (2026-10-15); inactive-environment
qualification against `a5d338c1` and live apply record against `140a50e8`
(2026-10-18).

The MCP server editor ([`mcp-management.md`](../../architecture/mcp-management.md))
reads and writes each agent platform's own MCP files and reports saved state,
runtime application and connection health separately. Its catalogue mirrors
each provider's merge and acceptance rules, so it is only as truthful as that
mirror. The remaining work keeps the mirror in line as bridges and pins move,
closes the apply paths that stop at "pending" or "restart required", and
collects the live evidence the shipped behaviour has never had.

## Current state

- Shipped in #838. Backend `apps/backend/src/core/mcp-management/` (`service.ts`,
  `catalog.ts`, `codecs.ts`, `providers.ts`, `apply.ts`, `evidence.ts`,
  `rollout.ts`), commands in `apps/backend/src/core/commands-registry-mcp.ts`,
  contract in `packages/protocol/src/mcp-management.ts`, UI in
  `apps/web/src/components/settings/mcp-servers/`, and the live-panel link
  "Manage saved MCP servers…" in `apps/web/src/components/layout/AgentInfoMcpSection.tsx`.
- Apply strategies (`apply.ts`): Claude, Cursor and Pi report
  `pending-next-turn`, then `applied` on bridge evidence. Codex queues one
  environment reload, then stays `pending-next-turn` (never `applied`).
  OpenCode is `restart-required`. Grok is `restart-required`, then `applied`
  once the bridge process is replaced. The live record below confirms the
  Claude, Codex, OpenCode and Cursor strategies on real providers; Grok and
  Pi are not yet live-qualified.
- Apply-path guards (see "Runtime application" in
  [`mcp-management.md`](../../architecture/mcp-management.md)): every outcome
  names the runtime generation (bridge pid plus provider session) it was
  observed against; a bridge older than the `mcpConfigReporting` marker is
  reported as such (`restart-required`, or an unconfirmable Claude
  `pending-next-turn`); an edit made to the source after the save is merged
  (flagged) or supersedes the change (waiting runtimes `cancelled`, re-apply
  refused) by `external-edits.ts`; one apply tracks 256 runtimes, lists 64 and
  counts the rest by state in `omittedStates`.
- Rollout and kill switch: `global.mcpManagement`, absent means everything on.
- Live inventory and connection actions are a separate axis:
  `NativeAgentMcpServer` (`packages/protocol/src/native-agent.ts`), bridge
  `GET /session/:id/mcp`, provider `mcpServers?` / `mcpServerAction?`
  (`apps/backend/src/core/agent-provider-contract.ts`), rendered by
  `McpServersPanel` (`AgentInfoButton.panels.tsx`).
- The Pi catalogue mirrors the Pi bridge's loader, which follows Pi 1.x's own
  (`markPiLoadRules` in `catalog.ts`, `piEntryShape` and `piLaunchBlock` in
  `codecs.ts`). Two tests hold it there over shared fixtures:
  `bridges/pi-bridge/src/mcp-config-upstream.test.ts` (bridge against the
  pinned Pi's `loadMcpConfig`) and `pi-mcp-parity.test.ts` (catalogue against
  the bridge). The rules are in
  [`mcp-management.md`](../../architecture/mcp-management.md).
- Since #950 the Claude bridge keeps one CLI runtime per session. Each turn's
  query plan re-resolves the inline MCP set, and `prepareJoin`
  (`bridges/claude-bridge/src/services/session-manager-prompt-launch.ts`)
  brings a running CLI to it through `syncClaudeRuntimeMcp`
  (`session-manager-prompt-mcp-sync.ts`). The CLI only unloads servers an
  earlier `setMcpServers` gave it, so the first update that drops a launch
  server restates the launch set first. A server it still runs after that is
  refused by a PreToolUse hook and reported as `staleServers`, and apply shows
  `restart-required` until a new CLI proves it gone.
  `mise run verify:claude:mcp-live` proves this on the real CLI without
  credentials.
- Current pins: Claude Agent SDK 0.3.296 / CLI 2.1.296, Codex 0.162.1,
  OpenCode 1.19.0, Cursor SDK 1.0.37, Grok 1.0.52, Pi 1.2.0. The live record
  below used exactly these.
- Live probe spec: `e2e/agent-testing/mcp-apply-live.spec.ts` (opt-in,
  `ORKESTRATOR_AGENT_TEST_LIVE_MCP=1`) with the dependency-free probe server
  `e2e/agent-testing/mcp-probe-server.mjs`; the verdict rules have unit tests
  in `mcp-apply-live-support.test.ts`. How to run it is under "Live apply
  record" below.
- Host Cursor and Pi project files follow the environment's execution
  policy: with project resources on they are `allowed` and apply plans them
  like any other source (`hostProjectTrust` in `providers.ts`; the target
  carries the resolved policy from `targets.ts`).

## Outstanding work

### Code

1. **External edits for runtimes no pass polls.** The external-edit rule
   (`external-edits.ts`) runs in the evidence pass, before a queued Codex
   reload and on re-apply. An operation whose waiting runtimes are only
   OpenCode or container `restart-required`, or Codex `pending-next-turn`
   after its reload, is never polled, so a later edit that removes its change
   leaves them waiting until the user applies again. Re-check such
   operations on a slow, bounded cadence (or on catalog reads of the same
   source) and retire them the same way.
2. **OpenCode application.** Choose a directory-scoped reconcile or an
   idle-gated server restart that keeps sessions, pending questions and the
   runtime-only `orkestrator` injection; add evidence so OpenCode can report
   `applied`. Trace how OAuth completes after `mcp.auth.start`
   (`apps/backend/src/core/opencode-capabilities.ts`); nothing calls
   `mcp.auth.callback`. Until then show external-authentication guidance.
3. **Codex.** A reload reaches existing threads at their next turn (live,
   2026-10-18: add, edit, rename and remove each reached two idle threads
   with no restart). Still missing: thread-level `applied` evidence, so the
   outcome stops at `pending-next-turn`, and `listMcpServers` in
   `bridges/codex-bridge/src/engine/app-server-engine.ts` reads one page
   (`limit: 100`) of `mcpServerStatus/list` and never follows `nextCursor`.
4. **Grok.** Per-session ACP application is not implemented: user servers are
   not passed at session load, and the collision rules are undocumented.
   Inventory stays process-level; Grok 1.0.52's `server_status` carries
   `sessionId` (see `vendorMcpServerStatus` in
   `bridges/acp-bridge/src/acp-mcp-inventory.ts`), which may allow per-session
   correlation.
5. **Saved-to-live row join.** Join saved entries to live runtime rows by
   exact native name plus target and runtime identity. `AgentInfoMcpSection`
   links by server name only (`manage(server.name)`).
6. **Live-inventory polish.**
   - Claude's no-control fallback in `readSessionMcpServers`
     (`bridges/claude-bridge/src/services/session-manager-catalog.ts`) uses
     `initData`, which `session-manager-prompt-handlers/init.ts` collapses to
     connected or failed.
   - Count-only "MCP" metric tiles remain for Claude and OpenCode in
     `apps/web/src/components/layout/AgentInfoButton.tsx`.
   - Runtime `error` strings are length-bounded (2,000 characters) but not
     redacted (`normalizeMcp` in `session-manager-catalog.ts`).
7. **Unmodelled layers.** Claude plugins, Cursor plugins and team settings,
   OpenCode remote or organisation configuration and Codex profiles are
   visible only in the live panel. Model one only where a passive reader
   exists.
8. **Replaced Claude server processes linger (blocked upstream).** On CLI
   2.1.296, a `setMcpServers` call that changes a server's configuration
   connects the new one but leaves the old process running, with its old
   environment, until the CLI exits; a server loaded from a settings file and
   then replaced the same way does too. Neither is offered to the model.
   Report it to Anthropic, then add the old process's exit to
   `session-manager-prompt-mcp-sync.live-probe.ts` once fixed.
9. **Grok project trust verdict.** `grokFolderTrust` (`native-policy.ts`)
    disagrees with Grok 1.0.52 in three ways, checked with `grok inspect`:
    - A grant on a non-git parent does not cover a repository below it, yet the
      verdict says it does.
    - A linked worktree of a trusted repository is trusted, yet the verdict
      says `unknown`. That is the usual Orkestrator host worktree.
    - A session whose policy turns project resources on now runs Grok with the
      gate off (`GROK_FOLDER_TRUST=0` from the ACP bridge), including every
      container session, which is reported `unknown`.

    Resolve the worktree's main checkout, stop walking past the git root, and
    take the session's policy into account.
11. **Older-bridge wording.** A Claude bridge from #838 until the
    `mcpConfigReporting` marker reports nothing before its first query, so the
    runtime shows "…cannot be confirmed until the environment restarts" — and
    is then confirmed by that first query, with no restart (seen live on
    2026-10-18). Say instead that it is confirmed once the bridge reports a
    query, or a restart if it never does (`olderBridgeOutcome` in
    `evidence.ts`).

12. **OpenCode rename probe calls the new name.** On 2026-10-21, in
    `qa-hosthome-0610` (see "Agent-test provider home isolation evidence" in
    [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)),
    `opencode-go/deepseek-v4.1-flash` answered every "call the old server"
    probe after a rename by calling the renamed one, in both runs (user and
    project scope); add, edit and remove passed, and the old server was gone.
    The same model passed on 2026-10-18. Make the probe name a tool the
    model cannot substitute (or accept a call to a different server when the
    old one is absent from the tool rows), or pin a model that follows it.

### Qualification

Shared prerequisites and batching are in
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).
Use temporary homes and harmless fixture servers; never the operator's files.

- **Re-derive provider rules at current pins.** The OpenCode and Grok source
  and precedence tables came from older binaries' embedded docs.
- **Grok and Pi live probes.** Run `mcp-apply-live.spec.ts` for Grok (user
  and project scopes, saved `enabled`, SSE) and Pi (user and project scopes)
  once the host has a current Grok login and a Pi provider sign-in; both were
  skipped on 2026-10-18 (see the record). Claude, Codex, OpenCode and Cursor
  have historical observations, with the corrected-check gaps below.
- **Corrected live probes and completion matrix.** Rerun the busy-turn and
  negative tool-call checks, including Claude's warm SSE stale-server hook,
  under the corrected harness. The [completion matrix](#completion-matrix)
  retains the original observations and names the cells still unverified;
  provider errors, silence and substituted tools do not prove removal.
- **Inactive environment.** Claude's apply evidence and recovery checks passed
  on 2026-10-18 (see
  [the record](#qualification-record-inactive-environment-2026-10-18)): busy
  save, a cut event stream, reload, a bridge restart (newer generation), a
  removal, a pre-marker bridge and a shared user file. Full model-facing
  qualification remains open. Two parts remain:
  - Rerun the spec in full mode (without `ORKESTRATOR_AGENT_TEST_MCP_APPLY_ONLY`)
    once the seeded Claude login is not rate limited. That proves the model's
    tool calls after the edit, the removal, the older bridge and the shared
    save; only the first add's call is proven today.
  - The process-wide variant across two Codex or two OpenCode sessions. It
    needs a profile whose Codex home is disposable: with the Codex credential
    source an agent-test profile uses the host's `CODEX_HOME`, so a user-scope
    save there would write the operator's own `config.toml`.
- **Real browser.** `e2e/agent-testing/mcp-apply-inactive.spec.ts`, registered
  in `playwright.browser.config.ts`, covers the live-panel link to the correct
  environment, settings dialogs, inactive apply, offline recovery and reload
  on the real stack at desktop width. Full mode also checks transcript tool
  results and post-reload live inventory (see the qualification record below).
  Remaining UI matrix: conflict recovery and secret replacement at desktop
  and narrow widths; a Claude fixture with one healthy and one failing server,
  reconnect from the panel, reload, and confirm status comes from the snapshot.
- **Containers and remote.** The read-only container catalogue (ok, absent,
  oversized, offline) through `mise run test:agent:docker`, and a remote
  browser showing correct backend paths and operation recovery.
- **Release decision.** Keep or narrow the all-on rollout default once the
  matrix is filled.

## Qualification record: inactive environment (2026-10-18)

Run on branch `qualify-mcp-inactive-apply-9ec53f801117` (from `a5d338c1`,
later merged with `main` at `66b7a51a`), Claude CLI 2.1.296 / Agent SDK
0.3.296, in the disposable profile `qa-mcp-inactive-0430`, with the live spec
`e2e/agent-testing/mcp-apply-inactive.spec.ts`:

```bash
mise run dev:test --profile qa-mcp-inactive-0430 --fixture --credential-source claude --agent-platforms claude
ORKESTRATOR_AGENT_TEST_PROFILE=qa-mcp-inactive-0430 ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 \
  ORKESTRATOR_AGENT_TEST_MCP_OLDER_CLAUDE_BRIDGE=/tmp/mcpq-old/repo/bridges/claude-bridge/dist \
  [ORKESTRATOR_AGENT_TEST_MCP_APPLY_ONLY=1] \
  mise run test:agent:browser -- e2e/agent-testing/mcp-apply-inactive.spec.ts
```

The spec creates two local environments, A and B (project resources on,
approvals auto), each with one Claude tab. Every edit goes to A's worktree
`.mcp.json` or the profile's isolated `~/.claude.json`. The fixture MCP server
is a script under `output/agent-testing/<profile>/` whose one tool answers
with a nonce that exists only in its arguments; a marker file counts every
call. The pre-marker bridge was built from `65077337` (the commit before
#1025) in a temporary worktree and swapped in only while A's bridge started.
Early runs also seeded Codex credentials for host onboarding; no Codex turn
ran and no Codex file was written, and the final runs used Claude alone.

### Result

The whole scenario passed once in apply-only mode (run 12: 1 passed, 0
skipped, 170 s), while Claude's API refused every request from the profile with
`429 · This request would exceed your account's rate limit` (see below). The
bridge records the MCP files a query was built from when the query starts,
before any API call, so a refused turn still proves what the runtime loaded.
Apply-only keeps every apply, generation and UI assertion; it drops only the
replies, tool calls, transcript text and the live panel's inventory.
Earlier full-mode runs (3 to 5) proved the model-facing half up to the reload.

| Step | Outcome on the real stack |
| --- | --- |
| Save and apply while A's turn runs | `pending-next-turn` with a 16-character generation, only A's runtime planned; the turn kept running through the save and a switch to B (full mode: finished with its reply). 25 s after it ended the runtime was still `pending-next-turn`: a query that started before the save is not evidence. |
| Next turn while A is inactive and the page's event stream is cut | Settings view open on A, browser offline and `window.stop()` (the page logged the drop and retried every 3 s). The turn made the runtime `applied`, "The session's latest message started with the saved configuration.", on the planned generation. Full mode: the model called the tool once and replied with the nonce. Back online the page reconnected and, with no Refresh, the card read "Saved and loaded". |
| Hard reload | Card still "Saved and loaded"; source revision equal to the operation's saved revision; the server effective; the file holding the saved arguments; no Stop control and an editable composer in A; the panel's "Manage saved MCP servers…" opened A's own context. The live panel's server list was checked only in full mode, which did not reach this point. |
| Bridge restart between save and next turn | Still `pending-next-turn` 25 s after the restart (the new bridge had run no query); after a turn, `applied` with "A newer run of this session, started after apply was planned, loaded the saved configuration." on a new generation (planned `BRwuHt7c9o6nug3K`, applied `GSmRe8sCpfVhelCK`); the settings card showed the same. |
| Removal while the stream survives an outage | Offline only (the stream stays connected): the change event arrived, the re-read failed, and the runtime became `applied`; back online the card read "Saved and loaded" without a Refresh. |
| Pre-marker bridge | Before a query: `pending-next-turn`, "This Claude bridge is older than this backend and does not report what it loads…". After a turn: `applied` (newer run), because bridges since #838 report what they loaded once something has. |
| Backend-user file shared by A and B | Both runtimes planned `pending-next-turn` with different generations; after a turn in B (on screen) and in A (inactive) both `applied`; the server effective in B's own target. |

### Defects found and fixed

- **The test stopped its own turns** (runs 1 and 2). The shared sidebar
  helper pressed Escape to close a tooltip right after Send, and Escape is
  Stop for the visible chat tab (`useEscapeToStop`); Claude reported the
  stopped stream as `[ede_diagnostic] result_type=user`. A diagnostic run saw
  the browser send `stop_native_agent_session` at the switch. This was flake
  0273, now resolved: `dismissSidebarTooltip` sends Escape only from the
  sidebar toggle, in the five live specs that navigated this way.
- **The agent panel's link lost its environment.** "Manage saved MCP
  servers…" sometimes opened the backend user instead of the session's
  environment. `ProviderMcpSettings` cleared the link's intent inside a
  `useMemo` during render; the settings page is lazy, so a discarded first
  render consumed it and the retry found nothing. The intent is now read
  during render and cleared after commit (regression test renders the section
  beside a component that suspends once).
- **A refresh lost offline was never repeated** (runs 3 and 4).
  `context.setOffline` leaves an open event stream connected, so the change
  event still arrived, but the re-read it triggered failed and nothing retried
  it: the view kept "not loaded until the session's next message" after the
  backend said `applied`. The MCP settings hooks now also re-read when the
  browser reports it is back `online` (regression test; the removal step
  above proves it live).

### Not proven: model output after an edit, a removal and a shared save

From run 6 on, every Claude request from the profile was refused with the
429 above, including a one-line prompt sent through the `orkestrator` CLI,
in every one of ten runs from 16:24 to 19:20, also on a pinned Sonnet model; the
same machine's other Claude login answered normally. The limit is on the host
login that profiles seed, which the other environments of this batch were
also using. So, in full mode, these have not run yet: the edited server's
version answering after a bridge restart, the removed tool not being called,
the older bridge's server answering, both environments calling the shared
server, and the live panel listing the server after the reload. Rerun the
command above without `ORKESTRATOR_AGENT_TEST_MCP_APPLY_ONLY` once that login
is no longer limited.

### Review follow-up: full-mode retry (2026-10-18)

Retried from `7a4a50c9` plus the review fixes in a fresh disposable profile,
`qa-mcp-review-1018`, with only Claude credentials and platforms enabled. The
pre-marker bridge was rebuilt from `65077337` in a temporary directory and
supplied through `ORKESTRATOR_AGENT_TEST_MCP_OLDER_CLAUDE_BRIDGE`. The run
explicitly removed `ORKESTRATOR_AGENT_TEST_MCP_APPLY_ONLY` from its environment:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-mcp-review-1018 ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 \
  ORKESTRATOR_AGENT_TEST_MCP_OLDER_CLAUDE_BRIDGE=<historical-bridge-dist> \
  mise run test:logged -- --name mcp-full-live -- mise run test:agent:browser -- \
  e2e/agent-testing/mcp-apply-inactive.spec.ts
```

The first busy turn started and the save stayed `pending-next-turn`, but
Claude rejected that turn with HTTP 429 (account rate limit). This is a failed
full-mode qualification, not an apply-only pass or a flake. It supplies no new
proof for the five outstanding model-facing checks listed above; all remain
open until the same full-mode command can run with a usable provider login.
Result: 0 passed, 0 skipped, 1 failed in 258.9 s (exit 1). Evidence:
`output/agent-testing/qa-mcp-review-1018/browser/results.json` and
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Jr9kqq/mcp-full-live.log.gz`.
The profile was stopped and reset after the run; browser evidence is retained
under `output/`, outside the disposable profile state.

## Live apply record (2026-10-18)

Live MCP apply probes and the provider completion matrix, run on macOS 27.0
(Apple Silicon), Bun 1.4.2, at the pins above, in the disposable profile
`mcpq2-0fcd`. Every edit went through the editor's own commands
(`mutate_mcp_definition` with "save and apply", then `get_mcp_operation`),
never a direct file write, except the Claude SSE case below.

### Method

- **Isolation.** An agent-test profile points `CODEX_HOME` and the XDG
  directories at the host's real provider homes when it authorizes the Codex
  or OpenCode credential source, so an editor write there would change the
  host's own files. The profile was therefore started with
  `--credential-source claude --credential-source cursor --credential-source
  grok --agent-platforms claude,codex,opencode,cursor,grok,pi`, which keeps
  both homes inside the profile, and two credentials were seeded into it by
  hand, owner-only: Codex got the access and id tokens with a dummy refresh
  token and a fresh `last_refresh` (so it never refreshed and could not
  rotate the host's login; `auth.json` was unchanged at the end), OpenCode
  got its one API-key provider entry. Claude, Cursor and Grok use the
  profile's own snapshots. The spec also refuses to write any source outside
  the environment's worktree or the profile's data directory, and grants
  Codex project trust only in that isolated `CODEX_HOME`.
- **Proof of a call.** `mcp-probe-server.mjs` logs every process start,
  `probe` call (with a fresh nonce) and exit. A call counts as reached only
  when the server logged that nonce, and a successful probe also needs the
  exact result line in the reply. The prompt is the same whether the call
  should work or not. A failing probe records the tool rows the turn
  produced (names and states only), which tells a model calling a different
  server's tool apart from a removed server still answering.
- **Steps per writable scope.** Add (tag `v1`), probe tab A; edit to `v2`,
  probe tabs A and B (two sessions; on the first scope tab A runs a shell
  `sleep 25` while the edit is saved and applied, and that turn must finish
  normally); rename, probe the new name (must answer) and the old one (must
  fail); on the first scope, restart the provider's bridge and probe the
  restored tab; remove, probe both tabs (must fail). A runtime left
  `restart-required` is restarted before probing, as the outcome asks; for a
  removal one probe is made first and recorded, not judged.
- **Command** (one provider per run; parallel runs against one profile are
  possible but see flake 0420):

  ```bash
  ORKESTRATOR_AGENT_TEST_PROFILE=<profile> ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 \
    ORKESTRATOR_AGENT_TEST_MCP_PROVIDERS=<provider> \
    ORKESTRATOR_AGENT_TEST_MCP_MODELS=opencode=opencode-go/deepseek-v4.1-flash \
    bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
    e2e/agent-testing/mcp-apply-live.spec.ts
  ```

  `ORKESTRATOR_AGENT_TEST_MCP_SCOPES` narrows the scopes. Each provider writes
  `output/agent-testing/<run>/mcp-apply-live/<provider>.json`.

### Runs

| Provider | Code | Result | Time |
| --- | --- | --- | --- |
| Claude | `25a1c56f` (spec) | 1 passed: user, private local, project, SSE stale server | 10.3 min |
| Codex | `2b8fc965` | 1 passed: user, project | 11.9 min |
| OpenCode (`opencode-go/deepseek-v4.1-flash`) | `ddc2074c` | 1 passed: user, project | 3.6 min |
| Cursor | `ddc2074c`, project scope again at `140a50e8` | 1 passed each | 6.3 min, 4.2 min |
| Grok | `2b8fc965` | **Skipped**: session creation 401, "Grok Build isn't signed in" | — |
| Pi | `2b8fc965` | **Skipped**: "Pi has no signed-in model provider" | — |

Earlier attempts that failed for harness reasons, all fixed in the spec
before the runs above: a background-task reply read as the probe's answer
(replies are now taken only after the turn's own prompt row), leftovers from
an interrupted run (cleared at start), the rename label (a renamed entry's
process keeps its `--label`), and Codex's code-mode models answering
"unavailable" without looking when the prompt offered that way out (the
prompt now asks every provider to search its full tool registry first;
reproduced with `codex exec`). A Claude re-run on the final code twice ended
its first turn on "Claude ended the turn on an API error" within seconds with
the host still signed in, so the Claude row is from the earlier pass; the
changed Claude wording is covered by unit tests.

### Completion matrix

These are historical observations from the original harness, not complete
qualification under the corrected checks. Negative results need a successfully
settled turn with an explicit unavailable reply; provider errors, silence and
substituted tools do not prove removal. The original busy check established only
an active turn, not a running shell command, so every Busy cell below is
unverified. The corrected harness waits for a unique shell marker and its
pending foreground tool row before saving. The Claude SSE removal must be
rerun without restarting the bridge; the original helper restarted first.
A run of the corrected SSE case in the disposable `mcp-review-fixes` profile
failed during warm-up on "Claude ended the turn on an API error", before any
probe ran (`output/agent-testing/mcp-review-fixes-sse/`). It is a failed
qualification, not renewed evidence for the SSE cell.

| Provider · scope | Add | Edit (A, B) | Rename (new / old) | Remove (A, B) | Busy | Restart and restore | Apply outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude · user `~/.claude.json` | reached | reached v2 both | answers / fails | fails both | unverified | reached after bridge restart | `pending-next-turn` → `applied` per tab after its turn |
| Claude · private local `projects[<worktree>]` | reached | reached v2 both | answers / fails | fails both | — | — | same |
| Claude · project `.mcp.json` | reached | reached v2 both | answers / fails | fails both | — | — | same |
| Claude · SSE in `.mcp.json` (written outside the editor) | reached after a bridge restart (the CLI loads its own files only at launch) | — | — | unverified: probe ran after restart, so an empty server log did not qualify the warm hook | — | — | `restart-required` with the still-loaded reason on the warm tab, `pending-next-turn` on the idle one |
| Codex · user `config.toml` | reached | reached v2 both | answers / fails | fails both | unverified | reached after app-server restart | `queued` → reload → `pending-next-turn` (never `applied`, by design) |
| Codex · project `.codex/config.toml` (trusted) | reached | reached v2 both | answers / fails | fails both | — | — | same |
| OpenCode · user `opencode.jsonc` | reached after restart | reached v2 both after restart | answers / unverified (model substituted the new name's tool) | still callable before the restart; fails both after it | unverified | reached | `restart-required` throughout, truthfully; nothing reaches a session without a restart |
| OpenCode · project `opencode.json` | same | same | same | same | — | — | same |
| Cursor · user `~/.cursor/mcp.json` | reached | reached v2 both | answers / fails | fails both | unverified | reached after bridge restart | `pending-next-turn` → `applied` per tab after its turn |
| Cursor · project `.cursor/mcp.json`, project resources on | reached | reached v2 both | answers / fails | fails both | unverified | reached | before the fix: `excluded` and `blocked-policy` although the session ran the server; after it: `pending-next-turn` → `applied` |
| Grok · user and project | skipped: no current Grok login (below) | | | | | | |
| Pi · user and project | skipped: no Pi provider sign-in (below) | | | | | | |

Not writable on these targets, so not probed: Codex system and managed
files, OpenCode inline, managed and `OPENCODE_CONFIG` layers (none present),
injected `orkestrator` servers, and every container target (read-only by
design). Cursor's project scope without the policy override stays excluded
and was not probed.

Auth limitation per provider, from the target capabilities: Claude has no
in-app MCP sign-in beyond its existing reconnect and elicitation; Codex has
its existing OAuth action; OpenCode uses `mcp.auth.start`, whose completion
is still unverified (code item 2); Cursor, Grok and Pi have none (Cursor
servers sign in through Cursor, Pi terminals through `/mcp login`). The
probe servers need no authentication, so no sign-in flow was exercised.

### Findings

- **Fixed: host Cursor and Pi project files under a project-resources
  policy** (was code item 8). The Cursor run showed the session loading and
  calling servers from `<worktree>/.cursor/mcp.json` while the catalogue
  showed the file `excluded` and apply reported `blocked-policy`. Environment
  targets now carry the resolved policy, both sources are `allowed` when it
  turns project resources on, and a session whose own policy is off stays
  `blocked-policy`. Re-run live for Cursor; Pi is covered by
  `service-apply-scope.test.ts`, host-on catalogue/bridge parity fixtures in
  `pi-mcp-parity.test.ts`, and the Pi bridge's own policy check
  (`mcp.ts`), since Pi could not run.
- **Fixed: the Claude still-loaded wording.** The `restart-required` reason
  and the stale-server hook said the CLI was "still running background
  work". Since #1055 a CLI also stays open between messages for its idle
  window (10 minutes by default). The original SSE removal result did not
  establish hook enforcement because the harness restarted before probing.
  Both now say the process is still open and closes after an idle period or
  when the session is stopped.
- **Codex reload reaches existing threads.** Both idle threads saw every
  change at their next turn without a restart (code item 3 is narrowed to
  evidence and paging).
- **OpenCode needs the restart its outcome asks for.** Before it, a removed
  tool still answered; after it, the call failed.
- **Codex code-mode models do not see MCP tools up front.** They reach them
  only from a code cell (`ALL_TOOLS`, `tools.*`). This is provider behaviour,
  not an apply defect, but a user asking a Codex tab about a new server may
  get "not available" until the model looks.
- **Profile isolation gap** (follow-up in
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)):
  an agent-test profile that authorizes Codex or OpenCode credentials edits
  the host's real `config.toml` / `opencode.json(c)` from the MCP editor.

### Skips

- **Grok:** the host's `~/.grok/auth.json` expired on 2026-10-16, so the
  profile received no snapshot and session creation answered 401. Renewing it
  would rewrite the host's Grok home, and using its refresh token from a copy
  would rotate the host's login, so neither was done.
- **Pi:** the host's `~/.pi/agent/auth.json` is empty and no provider key is
  set, so Pi creates no agent session.

### Cleanup

Every run deleted its environments (worktrees included) and removed its
probe entries; an interrupted run's leftovers were cleared by the next run.
The profile was stopped and reset afterwards. No host provider file was
written; the seeded credential copies lived only in the profile's data
directory and were deleted with it.

## Constraints and rationale

- Native files are the authority. No universal registry and no raw-file
  editor as the main flow; a provider CLI is used only for a pinned, bounded
  operation that demonstrably helps.
- Save is passive; apply is explicit. Apply never creates a session, starts a
  bridge, interrupts a turn, resolves an approval or elicitation, or sends a
  prompt. `applied` requires runtime evidence, and evidence digests stay
  backend-only.
- Every source and entry is addressed by an opaque id; no command accepts a
  filesystem path, and nothing here is a Control MCP tool.
- Secrets are edited as `keep` / `set` / `clear`. Project files refuse new
  literal secrets.
- `orkestrator`, `orkestrator-design` and `orkestrator_workflow_result` are
  protected in every provider.
- `strictMcpConfig` stays off for Claude: it would also drop plugin MCP
  servers, so the running-CLI sync cannot rely on it either.
- Mirrored merge and acceptance rules must be re-traced on every pin upgrade.
  For Pi the two parity tests fail when either side moves; the other
  providers have no such guard yet.
- Terminal sessions get guidance only; no command is injected.
- **Runtime generation** is the environment's recorded bridge pid plus the
  persisted provider session id, as a keyed 16-character label. It needs no
  bridge change and is read from the same records planning uses; the Grok
  restart proof already trusts the same pid. A bridge-reported generation
  would be more direct, but every bridge would have to report one and the
  backend would still need the persisted mapping to know which session it
  asked about. Evidence from a newer generation is accepted (the evidence
  rules already prove that run loaded the save) and says so; refusing it
  would leave a tab that really runs the change waiting. A read straddling a
  generation change is dropped and retried.
- **Older bridges are detected by a capability marker**, not a version
  number: `mcpConfigReporting` on every runtime-health body. Bridges report
  no usable version (the Claude and Codex health routes answer a fixed
  `1.0.0`), and a backend-recorded build id would flag every bridge after
  every upgrade. Bridges from #838 until the marker
  report `mcpConfig` once something loaded, so an `mcpConfig` of any shape
  also counts as reporting; such a bridge with nothing loaded yet is briefly
  read as older and corrects itself on its first load. Outcomes reuse
  existing states with explicit reasons, as Codex's older-bridge reload
  already did, rather than adding an `unsupported` apply state that older
  renderers could not label.
- **External edits are compared over the parsed server list**, so Claude's
  bookkeeping rewrites of `~/.claude.json` are not edits. A superseded change
  retires its waiting runtimes as `cancelled` (the state "superseded by a
  newer change" already uses) and refuses re-apply with `revision-conflict`;
  apply never rewrites the file, so there is nothing to re-materialize. An
  optional `cancelReason` (`superseded-external` / `superseded-local`) on
  those runtimes is what hides "Retry apply"; it is additive, so a new apply
  state was not needed for that either.
- **Fan-out is tracked, not dropped**: 256 runtimes per operation are
  scheduled and advanced, and only the snapshot is paged to 64, so wire and
  UI bounds are unchanged. Stored operations grow (about 0.5 KiB per tracked
  runtime); finished ones are shed first by the existing 4 MiB bound.

### Alternatives considered

| Approach | Benefit | Problem | Decision |
| --- | --- | --- | --- |
| Shell out to the provider CLI for every edit | Familiar provider semantics | Different scopes and flags, partial edits, subprocess output and secret exposure; no Pi equivalent | Only a pinned, bounded adapter operation where it demonstrably helps |
| One global Orkestrator registry replacing provider configs | Uniform UI and schema | Breaks native tools, duplicates sources and authentication, must override every provider's inheritance | Not the authority |
| Raw native-file editor only | Quick route to saved config | Poor source identity, validation, conflict handling, secret handling and apply feedback | At most a future advanced view |
| Provider-native persistence with a shared management contract | Fits existing engines and external tools | More adapter work; per-provider differences must be explicit | Chosen |

### Not planned

- Server marketplaces or automatic package installation.
- Cross-provider copying, bulk import or export.
- A provider account-login redesign or organisation policy editing.
- MCP resource browsing or tool execution.
- Arbitrary raw native-config editing.
- A new cross-platform credential vault.
- Per-server connection tests, unless they disclose that they execute and
  share the same policy and lifecycle boundaries.

## Open questions

- OpenCode and Grok: offer an explicit, idle-gated "restart to apply", or
  keep guidance only? Is per-session Grok application worth it when
  restart-based evidence works?

## Needs verification

- How OpenCode OAuth completes after `mcp.auth.start`.
- Agent-account homes: `syncClaudeAccountSettings`
  (`apps/backend/src/core/agent-accounts-homes.ts`) copies host
  `mcpServers` into an account's `.claude.json` one way, before launch, and
  Codex account homes link `config.toml` (`CODEX_SHARED_ENTRIES`). Check when
  a running Claude account session sees an editor write now that the runtime
  outlives turns, and say in the UI that servers added inside an account home
  are overwritten. The running-CLI sync only knows the names the bridge reads
  from `homedir()/.claude.json`, so a server the CLI loaded from the account's
  own `.claude.json` and nowhere else is never reported stale when removed.

## Related

- [0040-mcp-environment-delivery.md](0040-mcp-environment-delivery.md) for containers,
  remote backends and environment-private configuration.
- [0003-agent-accounts-and-sign-in.md](../agent-engines/0003-agent-accounts-and-sign-in.md) and
  [`agent-accounts.md`](../../architecture/agent-accounts.md).
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md) for older
  bridges.
- [`mcp-management.md`](../../architecture/mcp-management.md),
  [`control-mcp.md`](../../architecture/control-mcp.md) and
  [`agent-engines.md`](../../architecture/agent-engines.md).
- Upstream references: [Claude MCP](https://code.claude.com/docs/en/mcp),
  [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript),
  [Codex app-server](https://developers.openai.com/codex/app-server),
  [Codex MCP configuration](https://developers.openai.com/codex/mcp),
  [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/),
  [OpenCode config locations](https://opencode.ai/docs/config/),
  [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript),
  [Grok MCP](https://docs.x.ai/build/features/mcp-servers),
  [Grok settings](https://docs.x.ai/build/settings),
  [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup).
  For Pi, the `mcp.md` guide and `dist/extensions/mcp/config.js` inside
  `@earendil-works/pi-coding-agent`.

## Replaces

- `docs/improvements/mcp.md` (investigation; its environment and persistence
  findings are in [0040-mcp-environment-delivery.md](0040-mcp-environment-delivery.md))
- `docs/improvements/mcp/plan/00-index.md` (release gates, deferred
  follow-ups; the container gate is in
  [0040-mcp-environment-delivery.md](0040-mcp-environment-delivery.md))
- `docs/improvements/mcp/plan/01-compatibility-and-decisions.md` (live probes)
- `docs/improvements/mcp/plan/02-contracts-and-validation.md` (done)
- `docs/improvements/mcp/plan/03-targets-and-inventory.md` (row join,
  unmodelled layers)
- `docs/improvements/mcp/plan/04-persistence-and-secrets.md` (done)
- `docs/improvements/mcp/plan/05-operations-and-reconciliation.md` (apply-path
  gaps)
- `docs/improvements/mcp/plan/06-claude.md` (retained-runtime removal; its
  "setMcpServers not implemented" is stale since #950)
- `docs/improvements/mcp/plan/07-codex.md`
- `docs/improvements/mcp/plan/08-opencode.md`
- `docs/improvements/mcp/plan/09-cursor.md` (resume re-read probe)
- `docs/improvements/mcp/plan/10-grok.md`
- `docs/improvements/mcp/plan/11-pi.md` (done: the catalogue follows the Pi 1.x
  bridge rules)
- `docs/improvements/mcp/plan/12-ui-and-user-flows.md` (browser passes)
- `docs/improvements/mcp/plan/14-validation-and-rollout.md` (matrix, live,
  browser and inactive-environment evidence; container and remote parts are in
  [0040-mcp-environment-delivery.md](0040-mcp-environment-delivery.md))
- `docs/plans/sdk-coverage/07-mcp-inventory-and-management.md` (live-inventory
  polish and browser QA; its "stop parsing `~/.claude.json`" task is
  superseded, because that parse now feeds the inline set on purpose)
