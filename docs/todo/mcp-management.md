# MCP management

Checked against `main` at `2459b05c` (2026-10-15).

The MCP server editor ([`mcp-management.md`](../architecture/mcp-management.md))
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
  once the bridge process is replaced.
- Apply-path guards (see "Runtime application" in
  [`mcp-management.md`](../architecture/mcp-management.md)): every outcome
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
  [`mcp-management.md`](../architecture/mcp-management.md).
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
  OpenCode 1.19.0, Cursor SDK 1.0.37, Grok 1.0.52, Pi 1.2.0. The one recorded
  live probe used Claude 0.3.280 / 2.1.280.

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
3. **Codex.** Prove that a reload reaches an existing thread at its next
   turn, then add thread-level `applied` evidence. `listMcpServers` in
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
8. **Host Pi project files under a project-resources override.** An
   environment's execution policy can turn `projectResources` on for a host
   environment (`native-agent-execution-policy.ts`), and the host Pi bridge
   then loads `<worktree>/.pi/mcp.json`. The catalogue still marks that source
   excluded on every host (the `pi` case of `providerSources` in
   `providers.ts`) and apply reports it `blocked-policy` (`planRuntimes` in
   `apply.ts`). Derive the host project trust from the environment's resolved
   policy instead; check whether Cursor's project source has the same gap.
9. **Replaced Claude server processes linger (blocked upstream).** On CLI
   2.1.296, a `setMcpServers` call that changes a server's configuration
   connects the new one but leaves the old process running, with its old
   environment, until the CLI exits; a server loaded from a settings file and
   then replaced the same way does too. Neither is offered to the model.
   Report it to Anthropic, then add the old process's exit to
   `session-manager-prompt-mcp-sync.live-probe.ts` once fixed.

### Qualification

Shared prerequisites and batching are in
[live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).
Use temporary homes and harmless fixture servers; never the operator's files.

- **Re-derive provider rules at current pins.** The OpenCode and Grok source
  and precedence tables came from older binaries' embedded docs.
- **Live probes.** A Codex reload changes an existing thread's tools at its
  next turn; OpenCode and Grok pick up edits on restart; the Cursor SDK
  re-reads `~/.cursor/mcp.json` on resume; Grok saved `enabled` and SSE. For
  Claude, `verify:claude:mcp-live` already proves the in-place unload on the
  real CLI (status, the model's tool registry and the server process); what
  still needs a credentialed run is a model turn on a CLI kept alive by
  background work, where a call to a removed server that could not be
  unloaded (an SSE entry) is refused by the hook. For every provider, after a
  removal a harmless call to the removed tool must fail; a vanished status row
  is not proof.
- **Provider completion matrix.** For each provider and each advertised
  writable scope record: durable add, edit, rename and remove; actual tools
  after apply; two sessions or a busy session; restart and restore; the auth
  limitation. An unsupported cell gets an explicit reason, not a pass.
- **Inactive environment.** Keep environment A's provider busy and save and
  apply an edit; work continues. Switch to B, return after the safe boundary,
  then check revision, apply outcome, actual tools and controls. Repeat after
  a browser reload, with a dropped event stream and with a bridge generation
  change (the outcome must name the newer run). Also leave a pre-marker
  bridge running across a backend upgrade and confirm the older-bridge
  outcome. Add a shared-user variant across two environments and a
  process-wide variant across two Codex or two OpenCode sessions.
- **Real browser.** The live-panel link from a running session; a full pass
  after the dialog-layer fix (2026-09-24 confirmed it only by raising the
  layer); conflict recovery and secret replacement at desktop and narrow
  widths; a Claude fixture with one healthy and one failing server, reconnect
  from the panel, reload, and confirm the status came from the snapshot. No
  MCP spec exists under `e2e/agent-testing/`; consider adding one.
- **Containers and remote.** The read-only container catalogue (ok, absent,
  oversized, offline) through `mise run test:agent:docker`, and a remote
  browser showing correct backend paths and operation recovery.
- **Release decision.** Keep or narrow the all-on rollout default once the
  matrix is filled.

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
  apply never rewrites the file, so there is nothing to re-materialize.
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

- [mcp-environment-delivery.md](mcp-environment-delivery.md) for containers,
  remote backends and environment-private configuration.
- [agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md) and
  [`agent-accounts.md`](../architecture/agent-accounts.md).
- [mixed-version-compatibility.md](mixed-version-compatibility.md) for older
  bridges.
- [`mcp-management.md`](../architecture/mcp-management.md),
  [`control-mcp.md`](../architecture/control-mcp.md) and
  [`agent-engines.md`](../architecture/agent-engines.md).
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
  findings are in [mcp-environment-delivery.md](mcp-environment-delivery.md))
- `docs/improvements/mcp/plan/00-index.md` (release gates, deferred
  follow-ups; the container gate is in
  [mcp-environment-delivery.md](mcp-environment-delivery.md))
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
  [mcp-environment-delivery.md](mcp-environment-delivery.md))
- `docs/plans/sdk-coverage/07-mcp-inventory-and-management.md` (live-inventory
  polish and browser QA; its "stop parsing `~/.claude.json`" task is
  superseded, because that parse now feeds the inline set on purpose)
