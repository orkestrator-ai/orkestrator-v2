# MCP management

Checked against `main` at `2459b05c` (2026-10-15); inactive-environment
qualification against `a5d338c1` and live apply record against `140a50e8`
(2026-10-18). Code items 1, 9 and 11, Codex paging (item 3) and error
redaction (item 6) closed on 2026-10-22 from `b83ae534`, with the Grok trust
rules re-derived from the pinned Grok 1.0.52. Code items 2, 3, 5, 6 and 12
closed, items 4 and 7 decided, item 8 pinned by a canary, and the OpenCode
rules re-derived from the pinned OpenCode 1.19.4 on 2026-10-25 from
`ba7cc8d4` (branch `todo-0039-mcp-management-36df0f37c530`; see
[Assumptions and decisions](#assumptions-and-decisions)).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Replaced Claude server processes linger (code item 8)**: `setMcpServers` replacing a server under the same name leaves the old process alive. Status: blocked (upstream Claude Code; canary in place, report not filed).
2. **Re-derive Grok rules at 1.0.67**: trust rule, source and precedence table were derived at 1.0.52; the pin is 1.0.67 (also "Needs verification": whether 1.0.67 follows the 1.0.52 rule). Status: open.
3. **Parity guards for Codex and Grok**: the mirrored rules for these two have no test that fails when the pinned provider moves. Status: open.
4. **Grok live probes and the untrusted-project check**: run the live apply spec for Grok and confirm that an untrusted session skips project MCP servers. Status: blocked (no current Grok login on the host).
5. **Pi user-scope failure and rerun**: find out whether a user-scope Pi rebuild offers the tool, then rerun Pi. Status: open.
6. **Corrected live probes and completion matrix**: rerun busy-turn, negative, Claude warm SSE, OpenCode in-place reload, Codex `applied` and OpenCode rename checks under the corrected harness. Status: open.
7. **Inactive environment, full mode and process-wide variant**: rerun the Claude inactive spec with model checks, and add a two-session Codex or OpenCode variant. Status: open.
8. **Real-browser UI matrix remainder**: conflict recovery and secret replacement at desktop and narrow widths; a healthy plus failing Claude server with reconnect and reload. Status: open.
9. **Containers and remote**: container catalogue through the Docker suite and a remote-browser check. Status: partly done (container behaviour superseded by 0040).
10. **Release decision on the all-on default**: keep or narrow the rollout once the matrix is filled. Status: blocked (on tasks 4 to 7).
11. **OpenCode user-file apply and sign-in follow-ups**: whether to offer an explicit idle-gated restart for user files (open question), and whether `mcp.auth.authenticate` could be driven from the panel (needs verification). Status: open (decision only).
12. **Agent-account homes**: when a running Claude account session sees an editor write, a UI note that account-home servers are overwritten, and stale-server reporting for account-only servers. Status: open.

### 1. Replaced Claude server processes linger (code item 8)

**Problem.** When the editor changes a Claude stdio server under the same name, the running CLI connects a new process but never stops the old one, which keeps its environment (possibly old credentials) until the CLI exits. Every Claude user who edits a running session's server is affected; the leak is bounded by the CLI's lifetime (idle window of 10 minutes by default since #1055).

**Context.** This is CLI behaviour in `Query.setMcpServers`. The file pinned it with a canary and drafted a report for Anthropic, leaving the filing to a maintainer.

**Investigation.** The pin is unchanged: Claude Agent SDK 0.3.309 (`bridges/claude-bridge/package.json:16`), CLI 2.1.309 (`packages/toolchain/src/manifest.ts:7`). The canary is in `bridges/claude-bridge/src/services/session-manager-prompt-mcp-sync.live.test.ts:79-81` (asserts both processes alive, with a comment to change it to `alive: ["alpha"]` once fixed) and runs via `mise run verify:claude:mcp-live`. Nothing in git history suggests the report was filed.

**Decisions.**

- **Report it upstream now, or keep waiting on the canary?**
  - **A maintainer files the drafted report now (recommended).**
    - Pros: the draft and repro script exist; filing is the only way the upstream fix becomes likely; the canary already tells us when it lands.
    - Cons: outward-facing, so it needs a person to do it; the repro references an internal probe script that needs a standalone version.
  - **Keep waiting on the canary at each SDK bump.**
    - Pros: no outward action.
    - Cons: may never be fixed; the item stays blocked indefinitely.
  - **Work around it in the bridge (restart the CLI when a same-name server's config changes).**
    - Pros: no lingering process, independent of upstream.
    - Cons: a CLI restart costs a process spawn and drops in-process state; the bridge deliberately keeps one runtime per session (#950).

### 2. Re-derive Grok rules at 1.0.67

**Problem.** The catalogue's Grok trust rule, source list and precedence were traced at 1.0.52. The pin moved to 1.0.67, so Grok rows may be wrong about which servers load.

**Context.** The rule is in `grokFolderTrust` (`apps/backend/src/core/mcp-management/native-policy.ts:241`, doc comment naming 1.0.52 at `:232`) and `grokSources` (`apps/backend/src/core/mcp-management/providers.ts:476`, trust used at `:532`). `docs/architecture/mcp-management.md:72` documents it at 1.0.52. The method was `grok inspect` in throwaway `GROK_HOME`s, which needs no login.

**Investigation.** The pin is `grok: "1.0.67"` (`packages/toolchain/src/manifest.ts:9`, `docker/Dockerfile:196`), moved by `28590e68` (#1198) on 2026-10-23. The ACP bridge still runs Grok with `GROK_FOLDER_TRUST=0` when project resources are on (`bridges/acp-bridge/src/acp-provider-config.ts:139`), so the trust rule matters only for sessions without that policy.

**Decisions.**

- **How to re-derive?**
  - **Repeat the 1.0.52 method with `grok inspect` on the pinned toolchain binary in throwaway `GROK_HOME`s, then update the doc comment and architecture table (recommended).**
    - Pros: credential-free; same method makes results comparable.
    - Cons: still a manual trace that will need repeating at the next bump unless task 3 adds a guard.
  - **Read the rule out of the binary's embedded source, as done for OpenCode.**
    - Pros: finds rules `inspect` does not expose.
    - Cons: Grok is a compiled binary; tracing it is slower and less certain than for OpenCode's embedded JavaScript.

### 3. Parity guards for Codex and Grok

**Problem.** Claude, OpenCode and Pi each have a test that fails when the pinned provider's behaviour moves (`verify:claude:mcp-live`, `verify:opencode:mcp-live`, the two Pi parity tests). Codex and Grok have none, so a bump can silently make the editor's rows wrong.

**Context.** "Constraints and rationale" says mirrored rules must be re-traced on every pin upgrade and names this gap. `docs/development/upgrade-agents.md` is where a new guard would be listed.

**Investigation.** No Codex or Grok MCP parity or live test exists (`git ls-files` shows only `claude-plugin-mcp-parity.test.ts` and `pi-mcp-parity.test.ts` among parity tests). Codex app-server exposes `mcpServerStatus/list` and a config read, so a credential-free probe of which servers a fresh app-server loads is plausible; Grok has `grok inspect --json` and `grok mcp list`.

**Decisions.**

- **Build guards, and how?**
  - **Credential-free opt-in live tests, one per provider, each starting the pinned binary in a throwaway home with fixture files and comparing its listing with the catalogue's effective rows, exposed as `verify:*` mise tasks like the OpenCode one (recommended).**
    - Pros: same pattern as the existing guards; catches drift at upgrade time; no tokens.
    - Cons: two new tests to maintain; opt-in, so they only help if the upgrade checklist runs them.
  - **Rely on the manual re-trace at each bump (status quo).**
    - Pros: no code.
    - Cons: exactly what let Grok drift from 1.0.52 to 1.0.67 untraced.

### 4. Grok live probes and the untrusted-project check

**Problem.** Grok is the only provider whose apply strategy (`restart-required` then `applied`) has never run live, and whether an untrusted Grok session really skips project MCP servers is unknown because `grok inspect` lists them either way.

**Context.** The host's Grok login expired on 2026-10-16/19. Refreshing from a copy would rotate the host's login, so the earlier runs skipped Grok. 0015 holds the related trust evidence for instructions, commands and skills.

**Investigation.** Nothing has changed the blocker. Profile isolation since `d4171748` (#1116) means a profile authorising the Grok credential gets a snapshot of the host login, so once the host is signed in again the run needs no hand-seeding.

**Decisions.**

- **How to obtain a usable Grok login?**
  - **The operator signs in to Grok on the host, then runs the spec in a fresh profile with `--credential-source grok` (recommended).**
    - Pros: uses the supported snapshot path; no token handling by the agent.
    - Cons: depends on a person; the login may expire again before the run.
  - **Use a separate test Grok account seeded only into the profile.**
    - Pros: decoupled from the operator's login.
    - Cons: needs an account to exist and its credentials handled carefully.
- **Should the untrusted-project check be a live session or retired?**
  - **Run it in the same session: a project `.grok/config.toml` server, project resources off and no trust grant, and check the session's live inventory (recommended).**
    - Pros: the only real evidence; cheap once logged in.
    - Cons: shares the login blocker.
  - **Retire it, keeping the catalogue's trust gate as documented.**
    - Pros: no login needed.
    - Cons: if Grok loads untrusted project servers, the editor understates what runs, a security-relevant mismatch.

### 5. Pi user-scope failure and rerun

**Problem.** On 2026-10-22 four user-scope Pi probes failed with the runtime reporting `applied` while the model answered "unavailable" without a tool call. Either the Pi bridge rebuilt without offering the server (a real bug that would make `applied` false) or the model did not look.

**Context.** Pi was 1.2.0 then; it is now 1.4.0 (`packages/toolchain/src/manifest.ts:11`, `bridges/pi-bridge/package.json:17`). The project scope passed every probe in the same run.

**Investigation.** The user path agrees between bridge and editor: the bridge fingerprints `<agentDir>/mcp.json` (`bridges/pi-bridge/src/mcp.ts:267-269`) and the editor resolves the same directory from `PI_CODING_AGENT_DIR` (`apps/backend/src/core/mcp-management/providers.ts:94`, source at `:840`). `bridges/pi-bridge/src/mcp.ts` has not changed since `e37fc50e` (2026-10-25). The harness still cannot tell the two causes apart: it reads the session's MCP inventory only when a probe expected to fail produced tool rows (`e2e/agent-testing/mcp-apply-live.spec.ts:653-660`), not when a probe expected to reach produced none, which is exactly the Pi failure.

**Decisions.**

- **How to diagnose?**
  - **Extend the harness to record the session's live inventory on every failed probe, then rerun Pi at 1.4.0 (recommended).**
    - Pros: one small harness change turns an ambiguous failure into a clear one for every provider; the rerun also qualifies Pi at the current pin.
    - Cons: a change to a large live spec; needs a Pi login with a provider the model accepts.
  - **Rerun Pi unchanged and hope it passes.**
    - Pros: no code.
    - Cons: a pass after run 6 and a failure in run 7 already showed the result is not deterministic; another failure would be just as ambiguous.

### 6. Corrected live probes and completion matrix

**Problem.** The matrix holds observations from the original harness. Busy-turn cells are all unverified, the Claude warm SSE stale-server hook was never exercised without a restart, and the 2026-10-25 behaviours (OpenCode project scope `applied` without restart, Codex `applied` after the next turn, OpenCode rename absence by inventory) have never met a model. These outcomes are on by default for every provider.

**Context.** The item says the runs were not done because provider logins had to be seeded into a disposable profile by hand.

**Investigation.** That blocker is stale. Since `d4171748` (#1116, 2026-10-21) every agent-test profile has its own `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and XDG directories and receives an owner-only, refresh-token-free snapshot of an authorised login (`createBackendProcessEnvironment`, `apps/desktop/electron/backend-process.ts:186`; `seedAgentTestProviderCredentials`, `apps/desktop/scripts/dev/profile-io.ts:849`; recorded in `docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md:53-60`), and the spec's own safety header says so (`e2e/agent-testing/mcp-apply-live.spec.ts:40-43`). The "Isolation" paragraph of the 2026-10-18 method describes the old behaviour. The corrected busy check and inventory judgement are in the spec (`:16-18`, `:653-669`). Pins have not moved since 2026-10-25 except Cursor SDK (now 1.0.40, `bridges/cursor-bridge/package.json:15`; the record used 1.0.37).

**Decisions.**

- **How to batch the runs?**
  - **One fresh profile per provider using `--credential-source <provider>`, the corrected spec, one provider per run (recommended).**
    - Pros: uses the supported isolation; a rate limit or login problem on one provider does not void the others; matches the per-provider JSON output.
    - Cons: six profile start-ups; a long wall-clock total.
  - **One profile with every credential and all providers in one run.**
    - Pros: a single run fills the matrix.
    - Cons: one 429 or expired login fails the whole batch, as happened on 2026-10-18; parallel use of one profile has flake 0420.
- **Update the stale isolation text now?**
  - **Yes: note under the 2026-10-18 method and in this item that hand-seeding is no longer needed since #1116 (recommended).**
    - Pros: removes the stated reason for not running; cheap.
    - Cons: none beyond a small edit.
  - **Leave it until the runs are recorded.**
    - Pros: one edit later.
    - Cons: the next reader may believe the run still needs manual credential handling.

### 7. Inactive environment, full mode and process-wide variant

**Problem.** The Claude inactive-environment scenario passed only in apply-only mode; the model's tool calls after an edit, a removal, an older bridge and a shared save are unproven. The process-wide variant (two Codex or two OpenCode sessions sharing one process) has never run.

**Context.** Both full-mode attempts on 2026-10-18 hit Claude 429s. The process-wide variant was held back because a Codex credential pointed the profile at the host `CODEX_HOME`.

**Investigation.** The second blocker is gone with #1116 (task 6). `e2e/agent-testing/mcp-apply-inactive.spec.ts` is Claude-only (it names no other platform), with `ORKESTRATOR_AGENT_TEST_MCP_APPLY_ONLY` controlling model checks (`:81-88`), so the process-wide variant needs new spec work, not just a run.

**Decisions.**

- **Is the process-wide variant worth building?**
  - **Yes for Codex only, as a parameterised mode of the existing inactive spec (recommended).**
    - Pros: Codex is the provider whose one app-server reload serves several threads, which is exactly the process-wide case; reuses the spec's apply and reload assertions.
    - Cons: new spec code and a Codex login per run.
  - **Cover it with `mcp-apply-live.spec.ts`'s two-tab probes instead.**
    - Pros: those already use two sessions per provider.
    - Cons: they do not switch environments or cut the event stream, so they do not prove the inactive path.
- **When to rerun full mode?**
  - **Now, in a fresh Claude profile; the 429 was a host-login rate limit on 2026-10-18 (recommended).**
    - Pros: the command is recorded; likely to pass with a non-limited login.
    - Cons: consumes Claude quota for a long run.
  - **Wait until task 6's Claude run, and combine.**
    - Pros: one Claude profile.
    - Cons: the two specs have different setups (two environments, older bridge), so combining saves little.

### 8. Real-browser UI matrix remainder

**Problem.** Conflict recovery and secret replacement have not been driven in a real browser at either width, and the panel's reconnect flow with a healthy and a failing Claude server has not been checked after a reload.

**Context.** The AGENTS.md matrix requires a real-browser path, reload and narrow viewport for layout-affecting interaction changes.

**Investigation.** `mcp-apply-inactive.spec.ts` sets only `DESKTOP_VIEWPORT` (`:211`) and has no conflict or secret steps; its "reconnect" refers to the event stream, not the MCP reconnect action. The panel's actions are ordered in `AgentInfoButton.panels.tsx:1302` (`sign-in`, `enable`, `reconnect`, `disable`).

**Decisions.**

- **Automate or hand-walk?**
  - **Hand-walk once in the same Claude profile as task 7, at desktop and 390-pixel widths, with screenshots of non-sensitive UI (recommended).**
    - Pros: cheap; conflict and secret flows are mostly static UI already unit-tested.
    - Cons: no regression protection.
  - **Add a Playwright spec for conflicts, secrets and reconnect.**
    - Pros: repeatable.
    - Cons: building conflicts and a failing server fixture is significant spec work for UI with good component coverage.

### 9. Containers and remote

**Problem.** The item asks for the "read-only container catalogue (ok, absent, oversized, offline)" through the Docker suite and a remote browser check. The container part describes behaviour that no longer exists.

**Context.** [0040](0040-mcp-environment-delivery.md) made container targets writable (environment overlay, persistent project writes), and owns container sessions and the remote-browser check. The matrix's "every container target (read-only by design)" line is also out of date.

**Investigation.** `CONTAINER_READ_ONLY_REASON` is retired (0040). No Docker-fixture spec under `e2e/agent-testing/` exercises the MCP catalogue (`mise run test:agent:docker` greps `Docker fixture`; only `browser-gateway.spec.ts` among those mentions MCP, for OAuth credential staging). 0031's two-machine row (`docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md:199`) lists this file for the remote check.

**Decisions.**

- **Where should this item live?**
  - **Close it here and point to 0040, which already has the container session, overlay UI and remote-browser runs; keep the remote check for "correct backend paths and operation recovery" only if 0040's remote check does not cover host-target rows (recommended).**
    - Pros: one owner for container and remote MCP qualification; removes a stale description.
    - Cons: needs the two remote checks merged carefully so backend-host paths are not dropped.
  - **Keep it here, rewritten for the writable catalogue.**
    - Pros: this file stays self-contained.
    - Cons: duplicates 0040's work and runs.

### 10. Release decision on the all-on default

**Problem.** MCP editing and apply ship enabled for every provider (`DEFAULT_MCP_MANAGEMENT_ROLLOUT` with `enabled: true` and all platforms for write and apply, `packages/protocol/src/mcp-management.ts:1683-1687`) while Grok has never run live and Pi is unqualified.

**Context.** The rollout gate and kill switch are `global.mcpManagement` (`apps/backend/src/core/mcp-management/rollout.ts`); it only narrows behaviour and never touches saved files.

**Investigation.** The default is unchanged since the file was written. The gate supports per-provider write and apply lists, so narrowing is a one-line default change.

**Decisions.**

- **What to do until the matrix is filled?**
  - **Keep all-on for Claude, Codex, OpenCode and Cursor; decide Grok and Pi apply after tasks 4 and 5, narrowing them to write-only if they still fail (recommended).**
    - Pros: the four providers have live evidence; limits exposure to the two unproven ones without removing editing.
    - Cons: Grok and Pi stay all-on until someone runs them; a later narrowing changes behaviour users already have.
  - **Narrow Grok and Pi apply now.**
    - Pros: no unproven apply outcome shown to users.
    - Cons: Pi's strategy was seen working live (`pending-next-turn` then `applied`), and Grok's is restart-based and conservative, so this may remove working features.
  - **Keep all-on for everyone and close the item.**
    - Pros: no change.
    - Cons: ignores the file's own release gate.

### 11. OpenCode user-file apply and sign-in follow-ups

**Problem.** User-scope OpenCode saves need a stop and start because OpenCode 1.19.4 caches `$XDG_CONFIG_HOME/opencode` for the server's lifetime, and the panel offers only CLI guidance for MCP OAuth.

**Context.** The open question and the struck "Needs verification" item. A server restart drops every pending question and permission in the environment.

**Investigation.** The OpenCode pin is still 1.19.4 (`packages/toolchain/src/manifest.ts:10`), so the traced cache and OAuth behaviour still hold, and `verify:opencode:mcp-live` will flag a change.

**Decisions.**

- **Offer an explicit idle-gated "restart OpenCode to apply"?**
  - **No for now; keep `restart-required` with guidance and re-check at the next OpenCode bump (recommended).**
    - Pros: apply keeps its rule of never interrupting work; the live guard will show if a bump removes the cache.
    - Cons: user-scope saves stay manual.
  - **Yes, behind an explicit button that waits for idle.**
    - Pros: one click for the user.
    - Cons: a bigger step than apply has ever taken; idle gating does not save pending questions in other sessions of the environment.
- **Drive `mcp.auth.authenticate` from the panel?**
  - **No; keep the CLI route and drop the verification item (recommended).**
    - Pros: the call opens a browser on the server's machine and blocks up to 5 minutes, wrong for remote browsers and containers.
    - Cons: one more step for a local user.
  - **Verify it with a real OAuth server and offer it only for host targets with a local browser.**
    - Pros: smoother local sign-in.
    - Cons: needs an OAuth fixture and a remote-browser exclusion rule.

### 12. Agent-account homes

**Problem.** With a Claude agent account, `syncClaudeAccountSettings` copies host `mcpServers` into the account's `.claude.json` one way before launch, overwriting servers added inside the account home, and nothing says so. Since a CLI runtime outlives turns, when a running account session sees an editor write is unclear, and the running-CLI sync cannot report a server that only the account's file loaded as stale.

**Context.** Linked to [0003](../agent-engines/0003-agent-accounts-and-sign-in.md). Codex account homes link `config.toml` instead (`CODEX_SHARED_ENTRIES`).

**Investigation.** `syncClaudeAccountSettings` is at `apps/backend/src/core/agent-accounts-homes.ts:267`, still a full replace of `mcpServers` (`:279-281`), called at `:363` before launch; `CODEX_SHARED_ENTRIES` is at `:46`. The behaviour the file describes is unchanged.

**Decisions.**

- **How to address it?**
  - **First measure: one live check of a running account session after an editor write, then add a UI note on the account's MCP target; treat stale-server reporting for account-only servers as a follow-up todo (recommended).**
    - Pros: the note is cheap and prevents silent loss; the check decides whether more is needed.
    - Cons: account-only servers remain unreported as stale until the follow-up.
  - **Link the account's `mcpServers` to the host file instead of copying.**
    - Pros: removes the overwrite and staleness classes.
    - Cons: `.claude.json` is one file holding both servers and account keys like `oauthAccount`, so it cannot be linked per key.

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
  environment reload, then `pending-next-turn`, then `applied` per thread once
  its session starts a turn after the reload (`codex-turn-evidence.ts`, read
  from the backend's own dispatch records). OpenCode queues one idle-gated
  `instance.dispose` per worktree for files an instance reads when it is built
  (project files, `.opencode` and config directories, `OPENCODE_CONFIG`),
  re-adds the runtime-only `orkestrator` entry, and is `applied` when the
  rebuilt instance's `mcp.status` lists the change; the user files in
  `$XDG_CONFIG_HOME/opencode` and container servers stay `restart-required`,
  because OpenCode 1.19.4 caches the user files for the server's lifetime.
  Grok is `restart-required`, then `applied` once the bridge process is
  replaced. The live record below confirms the Claude, Codex, OpenCode and
  Cursor strategies of 2026-10-18 on real providers; the new Codex turn
  evidence and OpenCode reload have unit tests, and the OpenCode reload's
  mechanism is proven on the pinned binary (`mise run
  verify:opencode:mcp-live`), not yet with a model in a live session. Pi's
  strategy was seen live on 2026-10-22 (`pending-next-turn`, then `applied`
  per probed tab), but its user-scope probes failed, so it is not qualified;
  Grok is unrun.
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
  credentials; it passed again on 2026-10-22 at CLI 2.1.296 (6.0 s, after
  one silent hang recorded as flake 0671), and on 2026-10-25 at CLI 2.1.309
  (9.4 s) with the new "replace" scenario (item 8).
- Current pins (2026-10-25): Claude Agent SDK 0.3.309 / CLI 2.1.309, Codex
  0.164.0, OpenCode 1.19.4, Grok 1.0.67, Pi 1.4.0. The live records below
  used the earlier pins: Claude Agent SDK 0.3.296 / CLI 2.1.296, Codex
  0.162.1, OpenCode 1.19.0, Cursor SDK 1.0.37, Grok 1.0.52, Pi 1.2.0.
- Live probe spec: `e2e/agent-testing/mcp-apply-live.spec.ts` (opt-in,
  `ORKESTRATOR_AGENT_TEST_LIVE_MCP=1`) with the dependency-free probe server
  `e2e/agent-testing/mcp-probe-server.mjs`; the verdict rules have unit tests
  in `mcp-apply-live-support.test.ts`. How to run it is under "Live apply
  record" below.
- Outside edits for waiting runtimes no pass polls (OpenCode or container
  `restart-required`, sessions with nothing to poll) are re-checked by
  `external-edit-watch.ts`: once a minute per operation, four per tick, inside
  the 24-hour evidence window, retiring or flagging them as the evidence pass
  does. A Codex runtime whose app-server already reloaded the change is held
  and not watched, since it keeps the change until its next reload.
- Grok project trust (`grokFolderTrust` in `native-policy.ts`, `grokSources`
  in `providers.ts`) follows the pinned Grok 1.0.52, checked with
  `grok inspect` in throwaway `GROK_HOME`s on 2026-10-22: the decision is the
  exact entry for the repository root (symlinks resolved, trailing slash
  tolerated), and for a linked worktree its main checkout's; a grant on a
  non-git parent, on the worktree itself, on a nested repository's parent, or
  spelled through a symlink (`/tmp` for `/private/tmp`) does not count. A
  session whose policy turns project resources on is `allowed`, because the
  ACP bridge runs Grok with `GROK_FOLDER_TRUST=0`. Containers already were.
- Codex `listMcpServers` and the runtime-health MCP panel follow
  `mcpServerStatus/list`'s `nextCursor` (100 per page, at most 10 pages; a
  truncated read keeps the last cursor). Live-inventory `error` strings are
  redacted with the shared `@orkestrator/protocol/secret-redaction` before
  their bound in every adapter: the Claude, Codex and Pi bridges, OpenCode's
  `mcp.status` mapping, and again in the backend relay for every HTTP bridge
  (`http-bridge-catalog.ts`). Cursor sets no `error`; ACP/Grok keeps only an
  allowlisted reason code.
- The live panel's "Config" link joins a live row to the saved row its
  session loads (`mcp-live-join.ts`): exact name, the live scope's sources,
  then the effective row, only within the link's provider and environment
  (Pi's sanitized spelling is matched and named). The settings view
  highlights that one row, says when other rows share the name, names
  injected, plugin and unknown rows, and shows that session's newest apply
  outcome (`runtimeId` = environment plus logical session).
- Claude's no-control fallback keeps each init status (`pending` →
  `connecting`, `needs-auth`, `disabled`, `failed`, anything else `unknown`)
  and the layer from the init row's `source` (`mcp-runtime-status.ts`).
  The count-only "MCP" tile is shown only for a session that reports no server
  list, for every provider.
- OpenCode MCP OAuth: `mcp.auth.start` alone never completes in the pinned
  1.19.4 (traced in the binary: no callback waiter is registered, so OpenCode's
  callback server on `127.0.0.1:19876` answers the browser "Invalid or expired
  state parameter"). The live panel therefore offers no OpenCode sign-in; a
  `needs-auth` row carries the hint "opencode mcp auth <server>", and the
  target capability says the same.
- Host Cursor and Pi project files follow the environment's execution
  policy: with project resources on they are `allowed` and apply plans them
  like any other source (`hostProjectTrust` in `providers.ts`; the target
  carries the resolved policy from `targets.ts`).

## Outstanding work

### Code

2. ~~**OpenCode application.**~~ Done 2026-10-25. Apply queues OpenCode
   runtimes of a local worktree like Codex: once every OpenCode session there
   is idle (backend activity, then OpenCode's own `session.status`, and never
   during a dispatch), the provider's existing `OpenCodeInstanceReload` calls
   `instance.dispose` for the worktree; the probe then posts the runtime-only
   `orkestrator` entry again (`OpenCodeAgentToolsReconciler.forget` plus a
   status read) and reads the rebuilt instance's `mcp.status`. `applied` when
   it lists the added, edited or renamed name (any listing for a removal),
   `restart-required` when it does not, `pending-next-turn` when the listing
   could not be read. Only sources an instance reads when it is built are
   reloaded; the user files in `$XDG_CONFIG_HOME/opencode` and container
   servers keep `restart-required` (see the decisions). OAuth after
   `mcp.auth.start` was traced in the pinned binary and never completes; the
   panel now gives the `opencode mcp auth <server>` route instead of a sign-in
   that cannot finish. Evidence: `service-apply.test.ts` (OpenCode cases),
   `commands-registry-mcp.test.ts` ("OpenCode reload probe"),
   `opencode-capabilities.test.ts` ("OpenCode MCP sign-in"), and
   `apps/backend/tests/opencode-mcp-reload-live.test.ts` on the real pinned
   1.19.4 (`mise run verify:opencode:mcp-live`, 2 passed, 3.4 s): a project
   file edit is not seen until `instance.dispose`, then the rebuilt instance
   lists only the renamed server, the old server's process and the
   runtime-added server are gone, and a stored session survives; a user-file
   edit is not seen even after `instance.dispose` and `global.dispose`.
   Remaining: a model-facing live run (in "Corrected live probes" below).
3. ~~**Codex.**~~ Done 2026-10-25. When the reload (or the answer that nothing
   was running) completes, each Codex runtime records its session's newest
   accepted dispatch and any dispatch still open; a newer accepted dispatch
   than both makes it `applied` ("The thread started a turn after Codex
   loaded the saved configuration."), within the 24-hour evidence window
   (`codex-turn-evidence.ts`; tests in `service-apply.test.ts`). Paging
   `mcpServerStatus/list` was already done. A live Codex run of the new state
   is still to do (in "Corrected live probes").
4. ~~**Grok.**~~ Decided 2026-10-25: no per-session ACP application. Grok
   loads user and project servers when its process starts; passing user
   servers again in `session/new` would run a second copy beside the file's
   one under rules nobody documents, and the bridge keys inventory by name,
   so the two would merge into one row. Restart-based evidence already
   proves application. Per-session correlation through `server_status`'s
   `sessionId` was not built: only the per-tab `orkestrator` entry can differ
   between sessions, and its shape needs a Grok login to verify. See the
   decisions.
5. ~~**Saved-to-live row join.**~~ Done 2026-10-25 (see current state):
   `mcp-live-join.ts`, `McpLiveJoinNotice.tsx`, the extended
   `McpSettingsIntent`, and tests in `mcp-live-join.test.ts`,
   `McpStatusAndStates.test.tsx` and `AgentInfoMcpSection.test.tsx`.
6. ~~**Live-inventory polish.**~~ Done 2026-10-25: Claude's fallback keeps
   init statuses and layers (`mcp-runtime-status.ts`; test in
   `session-manager-catalog-transport.test.ts`); the count-only tiles are gone
   whenever the server list is reported (`AgentInfoButton.test.tsx`); every
   bridge's error text is redacted (tests in `opencode-capabilities.test.ts`
   and `http-bridge-mcp-inventory.test.ts`).
7. ~~**Unmodelled layers.**~~ Decided 2026-10-25, per layer. No passive reader
   exists for Cursor plugins and team settings (held by Cursor's service),
   OpenCode remote configuration (fetched from `<url>/.well-known/opencode`
   and the active organisation's `<url>/api/config` on every instance build,
   traced in 1.19.4) or Codex profiles (Orkestrator never passes
   `--profile`), so they stay unmodelled and the live join names such rows as
   coming from a layer this editor does not read. Claude plugins do have one
   (`installed_plugins.json` and each plugin's `.mcp.json`), but mirroring
   them needs the CLI's enablement rules; that is
   [0121-claude-plugin-mcp-servers.md](0121-claude-plugin-mcp-servers.md).
8. **Replaced Claude server processes linger (blocked upstream).** Still true
   on CLI 2.1.309: the live probe's new "replace" scenario edits a server under
   the same name and finds both processes alive, while only the new one is
   connected and offered. `session-manager-prompt-mcp-sync.live.test.ts` now
   asserts that, so it fails when the CLI starts stopping the old process;
   then expect one `alpha` and close this item. Not yet reported to
   Anthropic: filing is outward-facing and was left to a maintainer. Draft:
   "Claude Code 2.1.309, Agent SDK `Query.setMcpServers`: replacing a stdio
   server's configuration under the same name connects a new process but
   never stops the old one; the old process keeps its environment until the
   CLI exits. Same for a server first loaded from `.claude.json` and then
   replaced. Repro: `bridges/claude-bridge/src/services/session-manager-prompt-mcp-sync.live-probe.ts`,
   scenario `replace`."
12. ~~**OpenCode rename probe calls the new name.**~~ Done 2026-10-25 in the
    harness: a probe that must fail, where the model called another probe
    server instead, passes only when the session's own MCP inventory (read
    from the projection right after the turn) lists that substitute and not
    the probed name (`absenceProvenBy: "inventory"`); with no inventory, or
    the old name still listed, it fails as before (`judgeProbe` tests in
    `mcp-apply-live-support.test.ts`). An OpenCode rerun is still to do.

### Qualification

Shared prerequisites and batching are in
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).
Use temporary homes and harmless fixture servers; never the operator's files.

- **Re-derive provider rules at current pins.** OpenCode: done for 1.19.4 on
  2026-10-25 from the loader embedded in the pinned binary (record below):
  the table holds, except that the managed folder on macOS is
  `/Library/Application Support/opencode` (fixed: `opencodeManagedDir`), and
  the user files are cached for the server's lifetime (apply now says so).
  Grok: the pin moved to 1.0.67 after the 1.0.52 trust re-derivation of
  2026-10-22, so its trust rule, source and precedence table all need
  deriving again with `grok inspect` in throwaway `GROK_HOME`s. Codex has no
  parity guard yet; Pi's two parity tests and Claude's live probe pass at the
  new pins.
- **Grok and Pi live probes.** Run `mcp-apply-live.spec.ts` for Grok (user
  and project scopes, saved `enabled`, SSE) once the host has a current Grok
  login (it expired on 2026-10-19, so Grok is still unrun). Pi ran on
  2026-10-22 (see [the Pi record](#live-apply-record-pi-2026-10-22)): the
  project scope passed every probe; the user scope failed four, with the
  runtime `applied` while the model answered "unavailable" without a tool
  call. Find out whether a user-scope Pi rebuild really offers the tool, then
  rerun Pi. Claude, Codex, OpenCode and Cursor have historical observations,
  with the corrected-check gaps below.
- **Corrected live probes and completion matrix.** Rerun the busy-turn and
  negative tool-call checks, including Claude's warm SSE stale-server hook,
  under the corrected harness. The 2026-10-25 changes also need their first
  model-facing run: OpenCode project scope should now reach the new server
  with no restart (`applied` after the in-place reload) while the user scope
  keeps `restart-required`; Codex runtimes should turn `applied` after each
  tab's next turn; and the OpenCode rename's "old fails" probe should pass on
  the inventory when the model substitutes the new name. Not run here: they
  need provider logins seeded into a disposable profile by hand (see the
  isolation note in the 2026-10-18 method), which this worker did not do with
  the operator's credentials. The [completion matrix](#completion-matrix)
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

## OpenCode 1.19.4 configuration loader (2026-10-25)

Read from the JavaScript embedded in the pinned binary
(`toolchains/opencode/1.19.4/darwin-arm64/opencode`, `Config.loadInstanceState`
and `ConfigPaths`), and checked live where it matters for apply
(`mise run verify:opencode:mcp-live`). Later layers win; `mcp` entries are
deep-merged.

| Order | Layer | Re-read on `instance.dispose`? |
| --- | --- | --- |
| 1 | Remote `<url>/.well-known/opencode` for each `wellknown` auth entry | yes (network) |
| 2 | `$XDG_CONFIG_HOME/opencode/config.json` < `opencode.json` < `opencode.jsonc` (plus the legacy TOML `config` migration) | **no**: cached with an infinite TTL, invalidated only when OpenCode writes the file itself (`Config.updateGlobal`); `global.dispose` does not reload it either (live) |
| 3 | `$OPENCODE_CONFIG` | yes |
| 4 | Project `opencode.json` < `opencode.jsonc`, found upward from the directory to the worktree root, outermost first; skipped with `OPENCODE_DISABLE_PROJECT_CONFIG` | yes (live) |
| 5 | Config directories: project `.opencode/` (unless disabled), then `~/.opencode/`, then `$OPENCODE_CONFIG_DIR`, each `opencode.json` < `opencode.jsonc` | yes |
| 6 | `OPENCODE_CONFIG_CONTENT` | yes (environment of the server) |
| 7 | Active organisation's `<url>/api/config` | yes (network) |
| 8 | Managed folder `opencode.json` < `opencode.jsonc`: `/Library/Application Support/opencode` on macOS, `%ProgramData%\opencode` on Windows, `/etc/opencode` elsewhere | yes |
| 9 | macOS MDM profile `/Library/Managed Preferences/[<user>/]ai.opencode.managed.plist` | yes (not modelled) |

MCP OAuth in the same binary: `MCP.startAuth` (`POST /mcp/{name}/auth`)
starts the callback server (`127.0.0.1:19876/mcp/oauth/callback` unless
`oauth.redirectUri` or `callbackPort` is set), stores the state and the
pending transport, and returns the URL. Only `MCP.authenticate`
(`POST /mcp/{name}/auth/authenticate`, and `opencode mcp auth [name]`)
registers a waiter for that state, opens the browser on the server's machine,
and calls `MCP.finishAuth`, which stores the tokens in OpenCode's
`mcp-auth.json` and reconnects the server. The callback server answers a
state nobody waits for with "Invalid or expired state parameter", so a
sign-in begun with `startAuth` alone cannot complete; the waiter times out
after 5 minutes.

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

## Live apply record: Pi (2026-10-22)

Run from this branch (`b83ae534` plus the changes above) on macOS, Pi 1.2.0,
in the disposable profile `qa-mcp-pi-1022` (`mise run dev:test --profile
qa-mcp-pi-1022 --fixture --credential-source pi --agent-platforms pi`), which
shares only the host's Pi `auth.json`; the user source resolved to the
profile's own `.pi/agent/mcp.json`, and the host `~/.pi/agent` gained no
`mcp.json` (`auth.json` unchanged; Pi's shared `models-store.json` cache was
rewritten). The profile was stopped and reset afterwards.

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-mcp-pi-1022 ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 \
  ORKESTRATOR_AGENT_TEST_MCP_PROVIDERS=pi \
  ORKESTRATOR_AGENT_TEST_MCP_MODELS=pi=openai-codex/gpt-6.1-sol \
  ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=1800000 ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=3600000 \
  mise run test:logged -- --name mcp-live-pi -- bunx playwright test \
  --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/mcp-apply-live.spec.ts
```

Playwright prints nothing between a test's start and end, so the default
300 s no-progress watchdog has to be raised for this spec.

**Harness fixes found on the way** (in `mcp-apply-live.spec.ts` and
`mcp-apply-live-support.ts`, with unit tests):

- The model in `ORKESTRATOR_AGENT_TEST_MCP_MODELS` only seeded the tabs'
  `initialAgentModel`, which never reaches a bridge. Pi therefore started on
  its first available model, `openai-codex/gpt-5.3-codex-spark`, which a
  ChatGPT login refuses. The spec now passes the model to
  `ensure_native_agent_session` and every `dispatch_native_agent_intent`.
  Earlier OpenCode rows may not have used the model they name either. For a
  ChatGPT login, Pi ids are `openai-codex/…`: `openai/gpt-6-sol` resolves but
  needs an API key, and Pi's bridge then keeps the fallback without saying
  so. This plan also refuses `openai-codex/gpt-5.5`.
- A read-only command that hit `ECONNRESET` ended a 19-minute run; `get_` and
  `list_` commands are now retried up to three times on a connection reset
  (mutations never are).
- Playwright's call log copied the gateway auth cookie into that run's
  `pi.json` and test output. Request errors are now rethrown without the call
  log and with the cookie redacted; the leaked runner log was deleted and the
  profile reset.

**Result (run 7, 1348 s, failed with 4 of 13 probes):**

| Scope | Add | Edit A (busy) / B | Rename new / old | Restart and restore | Remove A / B |
| --- | --- | --- | --- | --- | --- |
| User `~/.pi/agent/mcp.json` (profile home) | reached v1 | reached v2 / **failed**: reply "unavailable", no tool rows, no server log line | **failed** (same) / fails | **failed** (same) | **failed**: turn still running at 240 s / fails |
| Project `.pi/mcp.json`, project resources on | reached v1 | reached v2 / reached v2 | answers / fails | — | fails / fails |

Apply outcomes at every save: both tabs `pending-next-turn` ("Reconnects MCP
servers before the session's next message."), and each probed tab then
`applied` ("The session rebuilt its MCP servers from the saved
configuration."). The tab A busy turn finished normally while the edit was
saved and applied. In the failed user-scope probes the backend reported the
runtime `applied` while the model answered "unavailable" without calling a
tool. That is either a Pi bridge that rebuilt without offering the server,
or a model that did not look. The previous run (6) passed the same user
scope add, edit and rename steps before it hit the reset, which points to the
model, but that is not proven. The spec records no tool registry for Pi, so
the run cannot tell the two apart.

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
| Pi · user and project | skipped here: no Pi provider sign-in (below); run on 2026-10-22, see [the Pi record](#live-apply-record-pi-2026-10-22) | | | | | | |

Not writable on these targets, so not probed: Codex system and managed
files, OpenCode inline, managed and `OPENCODE_CONFIG` layers (none present),
injected `orkestrator` servers, and every container target (read-only by
design). Cursor's project scope without the policy override stays excluded
and was not probed.

Auth limitation per provider, from the target capabilities: Claude has no
in-app MCP sign-in beyond its existing reconnect and elicitation; Codex has
its existing OAuth action; OpenCode used `mcp.auth.start`, which was traced on
2026-10-25 and never completes (code item 2), so it now gives the
`opencode mcp auth <server>` route instead; Cursor, Grok and Pi have none (Cursor
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
  For Pi the two parity tests fail when either side moves; for OpenCode,
  `verify:opencode:mcp-live` fails when the user-file cache or the in-place
  reload changes; Claude's running-CLI behaviour has `verify:claude:mcp-live`.
  Codex and Grok have no such guard yet.
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

- Resolved 2026-10-25: OpenCode applies through an automatic, idle-gated
  in-place instance rebuild for the files an instance reads (no server
  restart); the user files and containers keep restart guidance. Grok keeps
  guidance only, and per-session Grok application is not worth it while
  restart-based evidence works (see the decisions).
- Whether to offer an explicit, idle-gated "restart OpenCode to apply" for
  the user files. Not built: a server restart drops every pending question and
  permission in the environment, which is a bigger step than apply has taken
  so far.

## Needs verification

- Whether an untrusted Grok session really skips project MCP servers. At
  1.0.52, `grok inspect --json` and `grok mcp list` list a project
  `.grok/config.toml` server whether or not `projectTrusted` is true, so they
  cannot show it. The catalogue keeps treating trust as the gate, as
  [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md)
  describes it (its live evidence covered instructions, commands and skills,
  not MCP servers); a live session check needs a Grok
  login (the host's expired on 2026-10-19). The host's own `grok` is 1.0.62,
  not the pin; the checks used the toolchain's 1.0.52.

- ~~How OpenCode OAuth completes after `mcp.auth.start`.~~ Traced 2026-10-25:
  it does not (see the OpenCode 1.19.4 record). Whether
  `mcp.auth.authenticate` could be driven from the panel (it opens the
  browser on the server's machine and holds the request up to 5 minutes) is
  not verified; the guidance route is what ships.
- Whether Grok 1.0.67 still follows the 1.0.52 trust rule and source table.
- Agent-account homes: `syncClaudeAccountSettings`
  (`apps/backend/src/core/agent-accounts-homes.ts`) copies host
  `mcpServers` into an account's `.claude.json` one way, before launch, and
  Codex account homes link `config.toml` (`CODEX_SHARED_ENTRIES`). Check when
  a running Claude account session sees an editor write now that the runtime
  outlives turns, and say in the UI that servers added inside an account home
  are overwritten. The running-CLI sync only knows the names the bridge reads
  from `homedir()/.claude.json`, so a server the CLI loaded from the account's
  own `.claude.json` and nowhere else is never reported stale when removed.

## Assumptions and decisions

Made on 2026-10-25 while closing the code items, without stopping to ask.

| Decision | Options | Choice and why | Pros | Cons |
| --- | --- | --- | --- | --- |
| OpenCode apply (item 2) | (a) keep `restart-required`; (b) idle-gated server restart; (c) idle-gated `instance.dispose` per worktree | (c), reusing the command refresh's `OpenCodeInstanceReload`: it is directory-scoped, already idle-gated twice, keeps stored sessions (proven live) and rebuilds MCP servers from disk | No restart, no lost sessions; old server processes exit; evidence from the rebuilt instance's own listing | Drops the runtime-only `orkestrator` entry (re-posted at once) and any pending question in that directory (only disposed while idle); a busy directory waits up to 30 minutes, then fails |
| OpenCode user files | (a) dispose anyway; (b) rewrite the user file through `PATCH /global/config` to invalidate the cache; (c) keep `restart-required` | (c): OpenCode 1.19.4 caches `$XDG_CONFIG_HOME/opencode` for the server's lifetime (traced and proven live); (b) would rewrite the user's file | Truthful outcome; nothing touches the user's file | User-scope saves still need a stop and start |
| OpenCode `applied` evidence | (a) a successful dispose alone; (b) dispose plus the rebuilt instance's `mcp.status` | (b): the name must be listed after an add, edit, enable or rename; a removal proves itself by the rebuild | A shadowing layer or a failed load shows as `restart-required` instead of a false `applied` | The status read builds the instance (starts its stdio servers) right after apply rather than at the next message |
| OpenCode containers | (a) dispose `/workspace` too; (b) keep `restart-required` | (b): the `orkestrator` re-post for containers runs on a different path, and no container run proved it | No new container behaviour without evidence | Container saves still need a restart |
| OpenCode MCP sign-in | (a) keep `mcp.auth.start` + open the URL; (b) drive `mcp.auth.authenticate`; (c) guidance | (c), as the item asked "until then": (a) never completes (traced), (b) opens a browser on the server's machine, blocks a request up to 5 minutes, and is unverified with a real OAuth server | Honest; the CLI route works wherever the server runs, container included | One more step for the user; the action from older renderers is refused with the same text |
| Codex `applied` (item 3) | (a) a bridge field on `/runtime-health` (per-thread last `turn/start`); (b) the backend's own `dispatchedRequestIds` | (b): Codex's session routes can cold-start app-server, so a bridge read is not no-touch; the backend already records every accepted dispatch | No bridge or protocol change; works across bridge restarts and for "not running" | Proves a turn was dispatched after the reload, not what the thread loaded; a dispatch open at reload completion is excluded, so that turn alone never proves it |
| Strategy name | (a) new `McpApplyStrategy` value for OpenCode; (b) keep `directory-restart`, change the description | (b): older renderers label the existing value | No compatibility path | The name says less than it does |
| Grok per-session apply (item 4) | (a) pass user servers in `session/new`; (b) keep restart-based apply | (b): Grok already loads the files at process start; a session copy would run beside it with undocumented collision rules and merge with it in a name-keyed inventory | No duplicate servers; nothing new to qualify without a login | A Grok change still needs a restart |
| Unmodelled layers (item 7) | (a) model every layer; (b) model only layers with a passive reader | (b): only Claude plugins qualify, and they need the CLI's enablement rules, so they moved to their own file (0121) | No guessed sources; the live join already labels such rows | Plugin servers stay visible only in the live panel for now |
| Live row join (item 5) | (a) name only (as before); (b) name, scope and target; (c) also by runtime | (c): exact name and target, live scope picks the source, then effective status and precedence; the session's apply outcome by `runtimeId` | One highlighted row; explains injected, plugin and unknown rows | Pi's sanitized names are matched by rule, which must track the bridge |
| Count-only MCP tiles (item 6) | (a) delete; (b) show only when no list is reported | (b): an older bridge that reports only the count still shows something | No duplicate number beside the list | Two code paths |
| Rename probe (item 12) | (a) a tool name the model cannot substitute; (b) pin another model; (c) accept a substitution when the runtime's inventory proves the old name gone | (c): a renamed process keeps its label and tool, so (a) cannot work; (b) breaks when the model changes | Absence is proven by the runtime, not by the model's choice | Needs the session to report an inventory (OpenCode does) |
| Item 8 report | (a) file it with Anthropic now; (b) draft it and pin the behaviour | (b): filing is outward-facing; the canary tells us when it is fixed | Nothing published without a maintainer | Still unreported |

## Related

- [0121-claude-plugin-mcp-servers.md](0121-claude-plugin-mcp-servers.md) for a
  read-only Claude plugin source (split from item 7).
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
