# MCP management

Checked against `main` at `2459b05c` (2026-10-15).

The MCP server editor ([`mcp-management.md`](../architecture/mcp-management.md))
reads and writes each agent platform's own MCP files and reports saved state,
runtime application and connection health separately. Its catalogue mirrors
each provider's merge and acceptance rules, so it is only as truthful as that
mirror. The remaining work brings the mirror back in line where bridges and
pins have moved (Pi most of all), closes the apply paths that stop at
"pending" or "restart required", and collects the live evidence the shipped
behaviour has never had.

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
- Rollout and kill switch: `global.mcpManagement`, absent means everything on.
- Live inventory and connection actions are a separate axis:
  `NativeAgentMcpServer` (`packages/protocol/src/native-agent.ts`), bridge
  `GET /session/:id/mcp`, provider `mcpServers?` / `mcpServerAction?`
  (`apps/backend/src/core/agent-provider-contract.ts`), rendered by
  `McpServersPanel` (`AgentInfoButton.panels.tsx`).
- Since #891 and #935 the Pi bridge resolves `mcp.json` with Pi 1.x rules
  (`loadMcpConfigFile`, `mergeMcpConfigEntries`, `mcpNamespace`,
  `resolveConfigValue`, `MCP_OVERRIDE_KEYS` in
  `bridges/pi-bridge/src/mcp-config.ts`). The backend mirror did not follow:
  `markPiLoadRules`, `isCandidate` and `identityOf` in `catalog.ts`, `piCodec`,
  `piLoadBlock` and `PI_OWNED` in `codecs.ts`, and `CWD_FLAG.pi`, `TERMINAL.pi`
  and `SIGN_IN.pi` in `providers.ts` still encode the pre-1.0 rules, and
  `service-pi.test.ts` asserts them.
- Since #950 the Claude bridge keeps one CLI runtime per session. Each turn's
  query plan re-resolves the inline MCP set, and `prepareJoin`
  (`bridges/claude-bridge/src/services/session-manager-prompt-launch.ts`)
  calls `setMcpServers` on the running CLI when it changed.
- Current pins: Claude Agent SDK 0.3.296 / CLI 2.1.296, Codex 0.162.1,
  OpenCode 1.19.0, Cursor SDK 1.0.37, Grok 1.0.52, Pi 1.2.0. The one recorded
  live probe used Claude 0.3.280 / 2.1.280.

## Outstanding work

### Code

1. **Pi 1.x catalogue parity (regression).** Bring `catalog.ts`, `codecs.ts`
   and `providers.ts` in line with `bridges/pi-bridge/src/mcp-config.ts`, and
   rewrite the `service-pi.test.ts` cases that assert the old rules:
   - `enabled: false` disables an entry exactly like `disabled: true`; it is
     Pi's own spelling and the one `pi mcp` writes. Today `piCodec.decode`
     reads only `disabled`, so an entry Pi disabled shows as enabled, and
     because `enabled` is preserved as an unknown field, no editor action
     clears it.
   - A disabled project server now replaces the same-name user server; the
     user entry no longer falls back. Fix the effective-row computation
     (`isCandidate`) and the remove and disable previews.
   - A project entry with no `command`, `url` or `type` that sets only
     `enabled`, `exposure` or `toolExposure` is an override of the user entry.
     Today the catalogue shows it invalid ("No command or URL").
   - Names that differ only in `-` and `_` are one Pi namespace across both
     scopes, and the later definition is rejected. Fold this into
     `identityOf`, collision checks and add or rename validation.
   - A user entry with `auth` is kept (it still shadows) but not launched; a
     project entry with `auth` is refused.
   - An entry with an unresolvable `$VAR` or `${VAR}`, a leading-`!` value or
     a reference to `BRIDGE_SECRET_ENV` is not launched but still shadows. The
     backend cannot see the bridge's environment, so label these as "may not
     start" rather than invalid.
   - The bridge's 64-entry cap counts every entry it reads from a file,
     disabled entries and overrides included; `markPiLoadRules` counts only
     enabled, loadable servers.
   - `cwd` is supported with `~` expansion, so `CWD_FLAG.pi` is wrong.
   - Prevent the next drift: a parity test that runs the bridge's
     `resolvePiMcpServers` and the backend catalogue over the same fixtures,
     or one shared implementation. Extend the Pi section of
     [`upgrade-agents.md`](../development/upgrade-agents.md), which already
     asks for the bridge loader to be re-read on each bump, to cover the
     backend mirror too.
2. **Pi terminal and sign-in capabilities.** Pi 1.2.0's CLI loads its
   built-in `mcp` extension (`builtInExtensions` in the package's
   `dist/main.js`); SDK sessions, and so the bridge, do not. Terminal Pi
   therefore reads `<agentDir>/mcp.json` and trusted `<project>/.pi/mcp.json`
   through its own loader (`dist/extensions/mcp/config.js`), which requires the
   `mcpServers` wrapper (a bare map works only in the bridge), reads only
   `enabled`, rejects `type: "sse"`, and has its own OAuth. Update
   `TERMINAL.pi` (`readsNativeConfig` and its guidance, which says Pi
   terminals have no MCP client) and the `SIGN_IN.pi` reason accordingly, and
   label bare-map files.
3. **Claude removals on a retained runtime.** The CLI also loads
   `~/.claude.json`, `.mcp.json` and `projects[cwd]` itself at launch
   (`settingSources`), and the pinned SDK documents that `setMcpServers` does
   not affect servers configured through settings files. A server removed or
   renamed in a file may therefore stay loaded until the runtime ends while
   evidence reports `applied`. Confirm with the live probe below; if it holds,
   report removal and rename as `restart-required` for Claude or retire the
   runtime at the next idle boundary.
4. **Apply-path gaps** (`service.ts`, `apply.ts`). No runtime or session
   generation is recorded with an applied revision. Older Pi and Cursor
   bridges cannot be told apart (no bridge version is recorded), so their
   `pending-next-turn` never resolves. An external edit made after apply was
   scheduled is not flagged. `pageRuntimes` keeps at most
   `MCP_MANAGEMENT_LIMITS.runtimesPerOperation` (64), so a plan with more than
   64 Codex environments drops the rest.
5. **OpenCode application.** Choose a directory-scoped reconcile or an
   idle-gated server restart that keeps sessions, pending questions and the
   runtime-only `orkestrator` injection; add evidence so OpenCode can report
   `applied`. Trace how OAuth completes after `mcp.auth.start`
   (`apps/backend/src/core/opencode-capabilities.ts`); nothing calls
   `mcp.auth.callback`. Until then show external-authentication guidance.
6. **Codex.** Prove that a reload reaches an existing thread at its next
   turn, then add thread-level `applied` evidence. `listMcpServers` in
   `bridges/codex-bridge/src/engine/app-server-engine.ts` reads one page
   (`limit: 100`) of `mcpServerStatus/list` and never follows `nextCursor`.
7. **Grok.** Per-session ACP application is not implemented: user servers are
   not passed at session load, and the collision rules are undocumented.
   Inventory stays process-level; Grok 1.0.52's `server_status` carries
   `sessionId` (see `vendorMcpServerStatus` in
   `bridges/acp-bridge/src/acp-mcp-inventory.ts`), which may allow per-session
   correlation.
8. **Saved-to-live row join.** Join saved entries to live runtime rows by
   exact native name plus target and runtime identity. `AgentInfoMcpSection`
   links by server name only (`manage(server.name)`).
9. **Live-inventory polish.**
   - Claude's no-control fallback in `readSessionMcpServers`
     (`bridges/claude-bridge/src/services/session-manager-catalog.ts`) uses
     `initData`, which `session-manager-prompt-handlers/init.ts` collapses to
     connected or failed.
   - Count-only "MCP" metric tiles remain for Claude and OpenCode in
     `apps/web/src/components/layout/AgentInfoButton.tsx`.
   - Runtime `error` strings are length-bounded (2,000 characters) but not
     redacted (`normalizeMcp` in `session-manager-catalog.ts`).
10. **Unmodelled layers.** Claude plugins, Cursor plugins and team settings,
    OpenCode remote or organisation configuration and Codex profiles are
    visible only in the live panel. Model one only where a passive reader
    exists.

### Qualification

Shared prerequisites and batching are in
[live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).
Use temporary homes and harmless fixture servers; never the operator's files.

- **Re-derive provider rules at current pins.** The OpenCode and Grok source
  and precedence tables came from older binaries' embedded docs.
- **Live probes.** A Codex reload changes an existing thread's tools at its
  next turn; OpenCode and Grok pick up edits on restart; the Cursor SDK
  re-reads `~/.cursor/mcp.json` on resume; Claude removal and rename on a
  retained runtime (item 3); Grok saved `enabled` and SSE; whether Claude SSE
  entries the bridge drops still run through the CLI's own load. For every
  provider, after a removal a harmless call to the removed tool must fail; a
  vanished status row is not proof.
- **Provider completion matrix.** For each provider and each advertised
  writable scope record: durable add, edit, rename and remove; actual tools
  after apply; two sessions or a busy session; restart and restore; the auth
  limitation. An unsupported cell gets an explicit reason, not a pass.
- **Inactive environment.** Keep environment A's provider busy and save and
  apply an edit; work continues. Switch to B, return after the safe boundary,
  then check revision, apply outcome, actual tools and controls. Repeat after
  a browser reload, with a dropped event stream and with a bridge generation
  change. Add a shared-user variant across two environments and a
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
  servers. A fix for item 3 cannot rely on it.
- Mirrored merge and acceptance rules must be re-traced on every pin upgrade.
  The Pi drift is what happens otherwise.
- Terminal sessions get guidance only; no command is injected.

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

- Which Pi disable spelling should the editor write, and should existing
  `disabled: true` entries be migrated (only through an explicit edit)?
- Claude removal on a retained runtime: report `restart-required`, or retire
  the runtime when idle?
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
  are overwritten.

## Related

- [mcp-environment-delivery.md](mcp-environment-delivery.md) for containers,
  remote backends and environment-private configuration.
- [agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md) and
  [`multi-account.md`](../plans/multi-account.md).
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
- Living-doc drift to fix:
  - [`mcp-management.md`](../architecture/mcp-management.md): the "Pi
    disabled and skipped entries" and "Pi normalized-name collisions" rules
    and Pi's `cwd` and saved-enable cells in the capabilities table predate
    Pi 1.x, and the sources table should say a bare map works only in the
    bridge. The Claude row in "Runtime application" still says "per-query
    reload (bridge re-reads files every query)", which is stale since #950.
  - The Pi notes in `AGENTS.md` and the Pi section of
    [`agent-engines.md`](../architecture/agent-engines.md) say "Pi's vendor
    SDK has no MCP client". Pi 1.2.0 ships one in its CLI; only the bridge's
    SDK sessions lack it.

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
- `docs/improvements/mcp/plan/11-pi.md` (its "done" status predates the Pi 1.x
  bridge rules)
- `docs/improvements/mcp/plan/12-ui-and-user-flows.md` (browser passes)
- `docs/improvements/mcp/plan/14-validation-and-rollout.md` (matrix, live,
  browser and inactive-environment evidence; container and remote parts are in
  [mcp-environment-delivery.md](mcp-environment-delivery.md))
- `docs/plans/sdk-coverage/07-mcp-inventory-and-management.md` (live-inventory
  polish and browser QA; its "stop parsing `~/.claude.json`" task is
  superseded, because that parse now feeds the inline set on purpose)
