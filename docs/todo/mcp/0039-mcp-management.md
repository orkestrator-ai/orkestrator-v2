# MCP management

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`; re-checked 2026-10-31
against `main` at `931e5541` (pins: Claude 2.1.314, Codex 0.166.0, Grok
1.0.70, OpenCode 1.19.5, Pi 1.4.0).

Checked against `main` at `2459b05c` (2026-10-15); inactive-environment
qualification against `a5d338c1` and live apply record against `140a50e8`
(2026-10-18). Code items 1, 9 and 11, Codex paging (item 3) and error
redaction (item 6) closed on 2026-10-22 from `b83ae534`, with the Grok trust
rules re-derived from the pinned Grok 1.0.52. Code items 2, 3, 5, 6 and 12
closed, items 4 and 7 decided, item 8 pinned by a canary, and the OpenCode
rules re-derived from the pinned OpenCode 1.19.4 on 2026-10-25 from
`ba7cc8d4` (branch `todo-0039-mcp-management-36df0f37c530`; see
[Assumptions and decisions](#assumptions-and-decisions)). Tasks 2, 3 and 12
closed and task 8 worked on 2026-10-31 from `931e5541` (branch
`todo-0039-mcp-management-d5f657bb2ee5`): Grok rules re-derived at 1.0.70,
Codex and Grok parity guards added, agent-account copies kept in step.
Tasks 14 and 11 closed and task 5's harness half done on 2026-11-06 from
`c1724ab7` (branch `mcp-management-0c257de34897-r1`; follow-ups
7220 (closed 2026-11-06; see [Port selection and the loopback address](../../architecture/container-lifecycle.md#port-selection-and-the-loopback-address-agent-tools-listents))
and 7221 (closed 2026-11-09; see [After an MCP server action](../../architecture/native-transcripts.md#after-an-mcp-server-action))).
Tasks 5, 6 (Claude, Codex and Pi), 7, 9 and 13 worked on 2026-11-06 from
`ee2cc842` (branch `mcp-management-3b93ef501ce9-r1`) with **fake-model runs
only**: the pinned CLIs, app-server and SDK against a scripted loopback model,
no login and no billed turn (see
[Fake-model live record](#fake-model-live-record-2026-11-06)). Task 6's
OpenCode cells worked on 2026-11-10 against `main` at `c98b20e6f`, again on
the loopback model only, reached through a custom OpenCode provider (see
[OpenCode on the loopback model](#opencode-on-the-loopback-model-2026-11-10)).
Task 1's agent part (the standalone repro) done on 2026-11-11 against `main`
at `14df96544` (pins: Claude 2.1.319, Agent SDK 0.3.319), credential-free;
only the canary flip, which waits on an upstream fix, is left.

### Tasks

1. **Replaced Claude server processes linger (code item 8)**: `setMcpServers` replacing a server under the same name leaves the old process alive. Agent part: write a standalone repro for the drafted upstream report, and flip the canary once an upstream release stops the old process. Status: open (depends on 7568: 0039 task 1, the report filing, and an upstream Claude Code fix). The repro is done (2026-11-11: `claude-mcp-replace-linger.live-probe.ts`, run beside the canary; at 2.1.319 a server loaded at launch lingers when replaced, one added through `setMcpServers` does not); only the canary flip is left.
2. **Re-derive Grok rules at 1.0.70**: trust rule, source and precedence table were derived at 1.0.52; the pin is now 1.0.70. Status: done (2026-10-31; trust rule unchanged, three catalogue gaps fixed).
3. **Parity guards for Codex and Grok**: the mirrored rules for these two have no test that fails when the pinned provider moves. Status: done (2026-10-31; `verify:codex:mcp-live`, `verify:grok:mcp-live`).
5. **Pi user-scope failure and rerun**: find out whether a user-scope Pi rebuild offers the tool, then rerun Pi. Status: done (2026-11-06, fake model: at Pi 1.4.0 every user-scope rebuild offered the server and every probe passed, so the 2026-10-22 failures were not a bridge that rebuilt without the tool; whether a real model looks is not claimed: that real-login rerun is a 7568 item, 0039 task 5).
6. **Corrected live probes and completion matrix**: rerun busy-turn, negative, Claude warm SSE, OpenCode in-place reload, Codex `applied` and OpenCode rename checks under the corrected harness. Status: done for every provider a loopback model reaches (2026-11-06, fake model: Claude, Codex and Pi passed every scope, busy and negative check, Claude's warm SSE hook and Codex `applied`; 2026-11-10, fake model through a custom OpenCode provider: OpenCode passed both scopes, busy and negative checks included, with the project scope `applied` by the in-place reload, the user scope `restart-required`, and the renamed server's old name refused); Cursor's cells moved to the manual-test checklist (7568) on 2026-11-10: they need a Cursor login, because Cursor's SDK talks only to Cursor's own service and has no loopback stand-in.
7. **Inactive environment, full mode and process-wide variant**: rerun the Claude inactive spec with model checks, and add a two-session Codex or OpenCode variant. Status: done (2026-11-06, fake model: the Claude spec passed in full mode, and the new Codex process-wide spec `mcp-apply-inactive-codex.spec.ts` passed; the optional pre-marker bridge step is retired, see the task; the real-model full run is a 7568 item, 0039 task 7).
8. **Real-browser UI matrix remainder**: conflict recovery and secret replacement at desktop and narrow widths; a healthy plus failing Claude server with reconnect and reload. Status: done (2026-10-31, credential-free spec; reconnect on a running CLI unexercised, follow-up 1163, deleted 2026-11-06; its live check is task 13; its reconnect case failed from 2026-11-06 with the panel left stale, follow-up 7221, and passes again since that fix on 2026-11-09).
9. **Containers and remote**: container catalogue through the Docker suite and a remote-browser check. Status: done (2026-11-06, doc only: container behaviour superseded by 0040; the remote check of host-target rows moved into [0040](0040-mcp-environment-delivery.md) task 3).
11. **OpenCode user-file apply and sign-in follow-ups**: whether to offer an explicit idle-gated restart for user files (open question), and whether `mcp.auth.authenticate` could be driven from the panel (needs verification). Status: done (2026-11-06; both recommended options kept: no restart button, the CLI sign-in route, and the `mcp.auth.authenticate` verification item dropped).
12. **Agent-account homes**: when a running Claude account session sees an editor write, a UI note that account-home servers are overwritten, and stale-server reporting for account-only servers. Status: done (2026-10-31; a live account session with a real login is unrun: it is a 7568 item, 0039 task 12).
13. **Claude MCP reconnect on a running CLI**: with a real Claude login, a reconnect on a warm CLI and on a probe after the CLI exits gives the right list and layers, and survives a reload. Moved from to-do 1163 (deleted 2026-11-06). Status: done (2026-11-06, fake model instead of a real login: the list, layers and reload are right on both paths; the panel's live refresh after the reconnect is 7221's; the real-login run is a 7568 item, 0039 task 13).
14. **Claude MCP rows read `unknown` after a refused CLI exits**: on a real browser, rows left `connecting` by a CLI that exited show `unknown` and still offer reconnect. Moved from to-do 1240 (deleted 2026-11-06). Status: done (2026-11-06; credential-free case in `mcp-ui-matrix.spec.ts`).

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

**Not done (2026-11-06).** Still the recommended option, still for a
maintainer: filing the report is an outward-facing action this work was not
allowed to take. The canary is unchanged.

**Split (2026-11-10).** Filing the report moved to the manual-test
checklist (7568). What stays here is the agent part: a standalone repro the
report can carry (the drafted one points at the internal
`session-manager-prompt-mcp-sync.live-probe.ts`, scenario `replace`), and,
once an upstream release stops the old process, changing the canary to
`alive: ["alpha"]` and closing code item 8.

**Outcome (2026-11-11): standalone repro written; canary unchanged.**

- `bridges/claude-bridge/src/services/claude-mcp-replace-linger.live-probe.ts`
  is one file that imports only `@anthropic-ai/claude-agent-sdk` and Node
  built-ins and is its own fixture MCP server (`--server`), so it can be
  attached to the issue as is (`bun add @anthropic-ai/claude-agent-sdk`, then
  `bun claude-mcp-replace-linger.live-probe.ts`; `CLAUDE_CLI_PATH` picks the
  executable). It runs each CLI in a temporary `HOME` and `CLAUDE_CONFIG_DIR`
  and sends no prompt, so no login and no model request. It loads `alpha` in
  one of three ways, replaces it through `setMcpServers` under the same name
  with another argument and env value, waits until the new version is
  connected, and reports which processes are still alive. Exit 1 means
  reproduced, 0 not reproduced, 2 an error; the last line is
  `REPLACE_LINGER_RESULT <json>`.
- Result on CLI 2.1.319 (pinned toolchain installed into a throwaway data
  directory; three runs, identical):

  | Scenario | How `alpha` v1 was loaded | After the replacement | After the CLI exits |
  | --- | --- | --- | --- |
  | `options` | the SDK's `mcpServers` option at launch | v2 connected; v1 and v2 running | none running |
  | `dynamic` | an earlier `setMcpServers` call | v2 connected; v1 stopped | none running |
  | `settings` | `mcpServers` in `.claude.json` | v2 connected; v1 and v2 running | none running |

  So the leak is narrower than the draft said: only a server the CLI loaded
  at launch (from the SDK options or a settings file) outlives its
  replacement; a server first added through `setMcpServers` is stopped. The
  bridge passes servers at launch, so its sessions are in the leaking case.
  The draft in code item 8 and the 7568 item are updated to match.
- `session-manager-prompt-mcp-sync.live.test.ts` gained a second test that
  runs the repro and pins this table, so the file a maintainer attaches keeps
  reproducing on the pin. Both it and the canary fail when upstream fixes the
  leak: flip both then. `mise run verify:claude:mcp-live` with
  `CLAUDE_CLI_PATH` at the throwaway 2.1.319 install
  (`mise run toolchain:install --data-dir <throwaway dir>` into the worktree's
  `output/p0039-r2/toolchain-data`, removed after the run; point
  `CLAUDE_CLI_PATH` at `toolchains/claude/2.1.319/linux-x64/claude` there) and every
  variable naming the real data directory unset (`CLAUDE_CONFIG_DIR`,
  `ORKESTRATOR_CLAUDE_ACCOUNT_HOME`, `CLAUDE_CODE_EXECPATH`,
  `ORKESTRATOR_RESOURCE_ROOT`, `ORKESTRATOR_APP_ROOT`): passed, 26.2 s
  (2026-11-11). The canary in that run also still passes
  (`alive: ["alpha", "alpha"]`), so the bug is not fixed upstream at 2.1.319.
  Disclosure: two earlier runs of the same task on 2026-11-11 (2 pass,
  13 expects, 25.9 s, and one after the SIGTERM fix) inherited the session's
  `CLAUDE_CLI_PATH`, so they executed the host's pinned 2.1.319 from the real
  data directory's `toolchains/bin`. That was a read-only execution; the
  probes give the CLI temporary `HOME` and `CLAUDE_CONFIG_DIR` and send no
  prompt, so no login or model request was made. The run above replaces them
  as the recorded evidence.
- Left: filing the report (7568) and, after an upstream fix, the canary flip.

### 2. Re-derive Grok rules at 1.0.70

**Problem.** The catalogue's Grok trust rule, source list and precedence were traced at 1.0.52. The pin moved to 1.0.67 and then 1.0.70 (#1473), so Grok rows may be wrong about which servers load.

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

**Outcome (2026-10-31).** Re-derived on the pinned 1.0.70 (installed hash-verified into a throwaway data directory with `mise run toolchain:install --data-dir`), with `grok inspect --json`, `grok mcp doctor --json` and `grok mcp list --json` in throwaway `HOME`/`GROK_HOME`s and no login, plus the user guide the binary unpacks into `$GROK_HOME/docs/user-guide` (diffed against 1.0.52's and 1.0.67's).

- **Trust rule: unchanged since 1.0.52.** The repository root, symlinks resolved, trailing slash tolerated; a linked worktree takes its main checkout's entry and its own is ignored (also when the main checkout declines); a grant on a non-git parent, an enclosing repository or a symlinked key does not count; `GROK_FOLDER_TRUST=0` and `[folder_trust] enabled = false` turn the gate off. New: only `[folders."<path>"] trusted = <bool>` (the shape `grok --trust` writes) is a decision; a bare boolean, a string, an array of tables or another key name all read as untrusted, while the catalogue accepted four of them as grants. Fixed (`folderTrustEntry` in `native-policy.ts`). Grok also reports a folder with nothing to hold back as trusted, which changes nothing for MCP rows.
- **The gate holds for MCP.** `grok mcp doctor` refuses to start an untrusted (or undecided) folder's project `.grok/config.toml`, `.mcp.json`, `.cursor/mcp.json` and Claude's `projects[<repo>]` servers ("repo-local (project-scoped) server not started for an untrusted folder"), and the probe server's own log shows no process. `inspect` and `mcp list` still list them either way. The catalogue gated the first three but not Claude's private entry; fixed (`compat-claude-local` now carries the project's trust).
- **Sources: `requirements.toml` defines servers.** `$GROK_HOME/requirements.toml` (and, by Grok's configuration reference, `/etc/grok/requirements.toml` after it) can define and pin MCP servers, and its definition outranks the user and project files. 1.0.52 and 1.0.67 behave the same, so this was missed at 1.0.52. Added as read-only `grok:requirements-user` (30) and `grok:requirements-system` (31) sources. A requirements entry that only sets `enabled = false` turns the server off.
- **Precedence: unchanged.** Project > user > managed (`$GROK_HOME` over `/etc/grok`); native > Claude (private entry > user entry) > Cursor (project > user) > `.mcp.json`. A linked worktree reads only its own files, not its main checkout's. `GROK_CONFIG` does not carry `mcp_servers`.
- **Compatibility switches: unchanged.** `inspect`'s `externalCompat` cells agree with `grokCompat` for config, managed, requirements, environment and project-file cases; `inspect` and `doctor` list a switched-off vendor's servers anyway.
- **Saved enable.** `grok mcp list` and `doctor` treat `enabled = false` and `disabled_mcp_servers` as off, as the catalogue does; `inspect` drops the first but still lists the second.
- Doc comments, `docs/architecture/mcp-management.md` (source table, "Grok's org layers") and unit tests (`providers.test.ts`, `service-grok.test.ts`) updated. The rules are held by task 3's guard.

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

**Outcome (2026-10-31).** Built as recommended: two opt-in, credential-free tests under `apps/backend/tests/` (slow tier by their `-live.test.ts` name), each running the pinned binary in throwaway homes against fixture files and comparing with the catalogue, exposed as `mise run verify:codex:mcp-live` and `mise run verify:grok:mcp-live` and listed in the Codex and Grok upgrade steps of `docs/development/upgrade-agents.md`. Binary from `CODEX_CLI_PATH`/`GROK_CLI_PATH`, else the toolchain directory as the OpenCode guard does.

- **Grok** (`grok-mcp-parity-live.test.ts`, 31 cases, 2.0 s on 1.0.70): 14 trust shapes (`inspect`'s `projectTrusted` against `grokFolderTrust`), the untrusted gate on every project-bound source (`mcp doctor`), 8 precedence pairs (`inspect`'s kept definition against the effective row), 6 compatibility-switch cases (`externalCompat` against `grokCompat`) and saved enable (`mcp list`). Run against the catalogue as it was, it fails 5 cases, the three gaps task 2 fixed.
- **Codex** (`codex-mcp-parity-live.test.ts`, 20 cases, 1.2 s on 0.166.0): `codex mcp list --json` in the repository against `codexProjectTrust` for 12 trust shapes, 6 same-name merge cases and the sources read. It found two mismatches, both fixed:
  - Trust keys are matched exactly: Codex ignores a key spelled through a symlink (even for a session started through that symlink) or with a trailing slash, which the catalogue counted as grants. The folder itself is resolved through symlinks. (`codexProjectTrust`; the old unit test asserting the opposite was rewritten.)
  - Codex merges same-name entries field by field, and the winning row's status did not: a project entry with only `args` (no command) runs with the user's command, one with only `enabled = true` turns a disabled user server back on, and one that replaces only the command keeps the user's `enabled = false`. The catalogue showed the first two as off and the third as running. Fixed with `codexMergedStatus` in `catalog.ts`.
  - Confirmed unchanged: worktree entry, then main checkout's; no ancestor grants; `$CODEX_HOME/managed_config.toml` is not a source.
- Not covered by either guard: `/etc/codex` and `/etc/grok` files (root needed) and live sessions (`mcp list`/`inspect`/`doctor` use the same loaders as a session, but the session path itself is task 4's and task 6's).
- Running the OpenCode guard at the new OpenCode pin 1.19.5 found it failing on this host ("opencode serve did not come up", also at 1.19.4): a request that reaches `opencode serve` while its first instance boots can hang, and the readiness poll had no request timeout. Each call is now bounded (15 s) and the readiness deadline is 60 s; it passes on 1.19.5 (2 passed, 3.8 s), so the user-file cache and in-place reload task 11 relies on still hold.

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

**Outcome (2026-11-06): harness half done, Pi rerun left.** The recommended
option, first half.

- `mcp-apply-live.spec.ts` now reads the session's live MCP inventory (name,
  status and tool count from the projection's `runtime.mcp`) after **every**
  failed probe, not only for a substitution on a probe that must fail. The
  verdict is judged again with that inventory, so a substitution can still be
  proven by it.
- `diagnoseProbe` (`mcp-apply-live-support.ts`, unit-tested in
  `mcp-apply-live-support.test.ts`) turns a failed probe into one cause, which
  the step record keeps as `diagnosis` and the summary line appends in
  brackets: `not-offered` (the inventory does not list the server: the rebuild
  never offered it, so an `applied` outcome was false), `offered-not-connected`
  (listed but not connected; the status is the detail),
  `offered-not-called` (listed and connected, and no tool row of the turn
  names it after a successful turn: the model did not look),
  `called-not-reached` (a tool row names it but the server logged no call), `still-offered` (a probe that must fail,
  and the session still lists the server), `no-inventory` (the session
  reported none), `turn-failed` (the turn failed before a server call was
  observed, so model non-use cannot be inferred) and `reached` (the server
  logged the call; the failure is in the reply or tag). The record keeps only probe-server rows of the inventory,
  plus a count of the other servers, so a missing name is not mistaken for a
  missing list.
- The Pi bridge serves that inventory (`GET /session/:id/mcp`, from the MCP
  client it owns), so the 2026-10-22 user-scope failures would now read
  `not-offered`, `offered-not-called` or `turn-failed` instead of only
  "unavailable". A logged server call remains `reached` even if the turn later
  fails.
- Checked: unit tests (all of `mcp-apply-live-support.test.ts` pass), the
  agent-testing typecheck, lint and format. The spec itself was not run: every
  probe needs a model turn.
- Correction to the investigation above: `bridges/pi-bridge/src/mcp.ts` has
  changed since `e37fc50e` (last on 2026-11-04, #1752); the user path
  (`<agentDir>/mcp.json`) is unchanged. Its user-server filter applies only to
  policies that restrict user MCP servers, which the live spec does not set.

**What the Pi rerun needs** (not done here: it needs a real login and billed
turns; it is the 7568 item "0039 task 5"):

- A Pi login with a provider and model the login accepts, shared into a
  disposable profile as in the [Pi record](#live-apply-record-pi-2026-10-22):
  `mise run dev:test --profile <p> --fixture --credential-source pi
  --agent-platforms pi`. The host's Pi `auth.json` is then readable by the
  profile; check afterwards that it is unchanged.
- The model named explicitly, a ChatGPT login using `openai-codex/…` ids
  (`ORKESTRATOR_AGENT_TEST_MCP_MODELS=pi=openai-codex/<model>`), with the
  raised no-progress and group timeouts from that record, at Pi 1.4.0.
- Then read each failed user-scope probe's `diagnosis` in
  `output/agent-testing/<run>/mcp-apply-live/pi.json`: `not-offered` after an
  `applied` outcome is a Pi bridge bug to fix; `offered-not-called` is the
  model after a successful turn, and qualifies the scope only if a repeat
  passes. `turn-failed` needs a successful rerun before attributing non-use
  to the model.

**Outcome (2026-11-06): Pi rerun on a fake model.** Not the real-login
rerun described above: the ticket allowed no login or billed turn. Pi 1.4.0
SDK and bridge ran against the scripted loopback model
(`e2e/agent-testing/mcp-fake-model.ts`, an OpenAI chat-completions provider
written into the profile's own Pi `models.json`), which calls a probed tool
whenever the session offers it. Run `mcp0039-fake-pi`, 1 passed, 292 s; the
command and table are in the
[fake-model record](#fake-model-live-record-2026-11-06).

- **User scope: every probe passed**, add, edit with tab A busy (the busy
  turn finished normally), rename new and old, restart and restore, remove
  on both tabs, with each probed tab `applied` and the server's own log
  showing the call. The offered tool list carried `mcp_mqu0_alpha_probe`
  after the add and edit and dropped it after the rename and removal.
- So the user-scope rebuild does offer the server at Pi 1.4.0: no probe read
  `not-offered`, and the 2026-10-22 failures were not a bridge that rebuilt
  without the tool. What this does not prove is whether a real model calls
  it; the fake always does. If a real-login Pi run repeats "unavailable"
  with `offered-not-called`, that is the model.
- Project scope passed the same way.

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

**Outcome (2026-11-06): Claude, Codex and Pi on a fake model.** One fresh
profile (`mcp0039-fake`), one provider per run, through the corrected spec
with the new fake-model mode (`ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1`).
Hand-seeding is no longer needed (the isolation note under the 2026-10-18
method now says so), and the
[fake-model record](#fake-model-live-record-2026-11-06) has the commands and
the full matrix.

- **Claude** (CLI 2.1.314, Agent SDK 0.3.314): user, private local and
  project scopes passed every step, busy edit included (the shell `sleep 45`
  was observed running before the save and the turn finished `BUSY-DONE`).
  The warm SSE case passed on the warm CLI: the bridge and session stayed
  the same, the removed server's call was refused by the hook and never
  reached it, and the warm runtime read `restart-required` after that turn.
  The first run failed only that last check, because the spec required
  `restart-required` before the turn; evidence rule 5 can only see a stale
  server at the turn's sync, so the check now runs after the probe turn
  (decision below). Rerun `mcp0039-fake-claude-sse`: passed.
- **Codex** (0.166.0): user and project scopes passed, busy edit included;
  every save was `queued`, then `pending-next-turn` after the reload, and
  each probed thread `applied` after its own next turn (the spec asserts
  it). The fake reached the tools from a code cell (Codex code mode offers
  only `exec`; MCP tools are on `tools.*` and in `ALL_TOOLS`), so a probe
  that must fail found no `ALL_TOOLS` entry.
- **Pi** (1.4.0): both scopes passed (task 5).
- **Left open, with reasons:** OpenCode's in-place project reload and its
  rename-by-inventory check (this ticket covered Claude, Codex and Pi only;
  an OpenCode fake could reuse the chat-completions route as a custom
  provider, but none was built), Cursor (needs a login) and Grok (task 4).
- These are fake-model observations. They prove what each runtime offered
  and what the probe servers logged, and that the apply outcomes followed;
  they are not evidence of how a real model behaves.

**Outcome (2026-11-10): OpenCode on the loopback model.** Run
`oc-loop-0039-mcp` on a fresh profile (`oc-loop-0039`, beelink, Linux,
OpenCode 1.19.5) with the same fake-model mode, now extended to OpenCode
(record and commands under
[OpenCode on the loopback model](#opencode-on-the-loopback-model-2026-11-10)).
It passed in 141 s, with every probe judged from the probe servers' own logs:

- **User scope** (the profile's global `opencode.json`): every save
  reported `restart-required` ("OpenCode keeps its user configuration until
  its server restarts"), as task 11 decided; after the restart the spec
  makes, add, the busy edit (both tabs on v2; the shell `sleep 45` was
  running before the save and the turn finished `BUSY-DONE`), rename (the
  new name answered, the old one was not offered) and the bridge restart
  all passed. Before its restart the removed server still answered one
  call, which is what `restart-required` says (recorded, not judged); after
  it both tabs were refused.
- **Project scope** (`<worktree>/opencode.json`, project resources on):
  every save went `queued`, then `applied` ("OpenCode rebuilt this
  worktree's instance from the saved configuration") with no restart, and
  the next turns saw it: add reached v1, the edit reached v2 on both tabs,
  the rename's new name answered and the old name was refused, and the
  removed server was refused on both tabs.
- **Rename by inventory:** in both scopes the old name was simply not
  offered after the rename (the fake found no `<server>_probe` tool and the
  server logged no call), so the inventory rule for a substituted name was
  not needed.
- Cursor's cells (they need a Cursor login) moved to the manual-test
  checklist (7568) on 2026-11-10. These are fake-model
  observations, not evidence of how a real model behaves.

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

**Outcome (2026-11-06): both parts, on a fake model.**

- **Claude full mode.** `mcp-apply-inactive.spec.ts` with
  `ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1` on a profile without a Claude
  login: 1 passed, 165.9 s (`mcp0039-fake-inactive`). Every model check ran:
  the busy turn kept running through the save and the switch (the fake holds
  that reply 30 s) and stayed `pending-next-turn` after it; the inactive turn
  with the stream cut was `applied` on the planned generation and the tool
  answered; the reload showed the reply and the live panel's `mcpqa`; after a
  bridge restart only the v2 server answered (`applied` on a newer
  generation); the removed tool was not called; and both environments called
  the shared user-file server. The marker file read `call mcpqa 1`,
  `call mcpqa 2` once each and `call mcpqu 1` twice.
- **Pre-marker bridge step: retired, not run.** A first attempt with the
  bridge rebuilt from `65077337` started it, but the backend's requests to it
  failed (`policy.push-failed reason=http-401`, activity reads refused), so
  the outcome kept the current bridge's reason. Every published release from
  v2.21.0 (the support floor) has the `mcpConfigReporting` marker, so a
  pre-marker bridge is a source build below the floor, and since the bridge
  credential verifier (2026-11-04) it cannot authenticate with today's
  backend. The step stays optional in the spec; the backend's pre-marker
  path is now unreachable from any supported bridge (see the decision).
  Both were removed on 2026-11-10: the spec step, and the backend's
  unmarked-`mcpConfig` reading and provider-specific older-bridge outcome
  (a body without the marker now gets one generic `restart-required`;
  [version compatibility](../../architecture/version-compatibility.md#retired)).
- **Codex process-wide variant (new spec).**
  `e2e/agent-testing/mcp-apply-inactive-codex.spec.ts`: environment A with
  two Codex threads on one bridge, the browser on environment B. 1 passed,
  53.1 s (`mcp0039-fake-inactive-codex`): one save planned both A threads
  (`queued`, each with its own generation) and none in B; one reload left
  both `pending-next-turn` on the same bridge pid; A1's turn with the page
  offline and the stream cut made A1 `applied` while A2 stayed
  `pending-next-turn` 25 s later; A2's own turn made it `applied`, bridge
  pid unchanged; after a hard reload the card read "Saved and loaded"; a
  removal was proven per thread the same way with no further call.

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

**Outcome (2026-10-31).** Not the recommended hand-walk: a repeatable spec, `e2e/agent-testing/mcp-ui-matrix.spec.ts` (registered in `playwright.browser.config.ts`, opt-in with `ORKESTRATOR_AGENT_TEST_MCP_UI=1`), on a `dev:test --fixture --no-agent-credentials --agent-platforms claude` profile (`mcp0039-ui`, stopped and reset afterwards). Final run: 2 passed, no retries, 109.5 s, at host load 25–53. Screenshots in `output/agent-testing/mcp0039-ui/mcp-ui-matrix/` (git-ignored).

- **Conflict recovery, 1440 and 390 px: pass.** Edit a `.mcp.json` server, open the review, change the file from outside, save: refused, file unchanged; "Reload latest and review again" keeps the edit and the second save keeps both the edit and the outside entry; the same after a page reload.
- **Secret replacement, 1440 and 390 px: pass.** A user-scope server in the profile's own `~/.claude.json` shows only "Value saved"; replace, review and save write the new value (compared in memory, never printed); neither old nor new value appears in the page's HTML in the list, editor, review, after saving, on reopening or after a reload.
- **Healthy and failing Claude server, reconnect, reload (desktop): pass.** Without credentials the Claude CLI still connects and reports its MCP servers before the turn fails "Not logged in", so no model is called. The projection read `mcpui-ok` connected and `mcpui-late` failed ("1 down"); after creating the missing script, a click on the failed row reconnected it and "down" cleared; after a hard reload the panel matched the backend projection (counts, statuses, tool counts).
- **Caveat and follow-up.** The refused turn's CLI exits, so the reconnect ran through the bridge's stand-in probe CLI, not a running session. That path replaced the session's whole list with the probe's: the injected `orkestrator` row vanished ("Tools 23 · 3 servers" to "Tools 2 · 2 servers") and the layers changed from `user` to `project`. Recorded as `1163-claude-probe-reconnect-inventory.md` (deleted 2026-11-06), fixed there on 2026-11-01; reconnect on a running CLI needs a turn the provider accepts, now tracked in task 13 here. That run passed only because the host was loaded enough for a read to reach the refused CLI before it exited; 1163 made it deterministic.
- **Defect fixed on the way.** A `dev:test` profile started from an Orkestrator agent shell inherits `NODE_ENV=production`, so its backend looked for packaged bridges and every Claude tab failed ("claude bridge directory not found"). `createBackendProcessEnvironment` (`apps/desktop/electron/backend-process.ts`) now drops an inherited `NODE_ENV=production` for development and agent-test profiles only, with a test in `apps/desktop/tests/backend-process.test.ts`.
- The host's "Docker containers can't reach Orkestrator" notice covers the dialog footer at 390 px; it comes from this host's firewall, not the MCP UI.

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

**Outcome (2026-11-06): closed here, doc only.** The recommended option.
The container half described read-only behaviour that no longer exists and
is [0040](0040-mcp-environment-delivery.md)'s (live container sessions, task
1; the overlay UI, task 2, done). The remote-browser half was compared with
0040's task 3, which checks the URL location hint, the container sign-in
reason and that no callback is offered, but not host-target rows. So the
backend-host part, "correct backend paths and operation recovery" for a
host target, was added to 0040's task 3 as a second check of the same
two-machine run, so it is not dropped. The stale "every container target
(read-only by design)" line under the completion matrix and the
"Containers and remote" qualification bullet now point there.

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

**Recommendation (2026-10-31).** Keep both recommended options: no restart button, and the CLI route for OpenCode MCP sign-in, with the `mcp.auth.authenticate` verification item dropped. New evidence: at the current pin 1.19.5 `verify:opencode:mcp-live` still shows the user files cached for the server's lifetime and the in-place reload working (2 passed, after the harness fix in task 3), so the reason for `restart-required` stands and nothing cheaper has appeared. A restart button becomes worth building only if user-scope OpenCode saves turn out to be common; revisit at the next OpenCode bump, when the guard reruns anyway.

**Outcome (2026-11-06).** Both recommended options taken. Neither needed new product code, because each keeps what already ships; building them meant checking that the shipped behaviour matches the decision, closing the open items and recording the decisions where a maintainer will meet them.

- **No "restart OpenCode to apply" button.** User-file saves keep `restart-required` with the guidance "OpenCode keeps its user configuration until its server restarts; stop and start the environment to load the change." (`OPENCODE_USER_RESTART` in `apply.ts`). The re-check is already wired to each bump: step 6 of the OpenCode upgrade in `docs/development/upgrade-agents.md` runs `verify:opencode:mcp-live` and says what to do if the user file starts being reloaded. The open question is closed, and `docs/architecture/mcp-management.md` now says the button is deliberately absent and why.
- **CLI route for OpenCode MCP sign-in.** A `needs-auth` row carries `OPENCODE_MCP_SIGN_IN_GUIDANCE` (`packages/protocol/src/native-agent.ts`), and the backend refuses a sign-in request with the same text (`opencode-capabilities.ts`); no code calls `mcp.auth.authenticate`. The "Needs verification" item is dropped, and the architecture doc gives the reason not to drive it from the panel.
- Nothing found while doing this gave a reason to take the other options. The pin is still 1.19.5, so the cache evidence above is current.

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

**Outcome (2026-10-31).** Measured first, then fixed, as recommended; the stale reporting was small enough to do here instead of a follow-up.

- **When an account session sees a save.** On an added account the bridge runs with `CLAUDE_CONFIG_DIR=<account home>` (`agent-accounts-active.ts`), so the CLI reads the account's copy of `.claude.json`, while the bridge reads the host file on every turn and pushes the inline set into the running CLI. So a running CLI picked up adds, edits and removals at its next message, as for the host login. But the copy was refreshed only when a bridge process launched, so the CLI the same bridge starts after an idle close loaded the old copy: a removed server came back, was not reported stale, and apply said `applied` because the bridge's digest of the host file matched. Servers added inside an account's own copy were never reported either.
- **Fixed.** The editor now refreshes every added Claude account's copy after a save of `claude:user` or `claude:local` (`mcp-management/claude-account-copies.ts`, same lock and merge as the launch sync), before apply. The backend marks an account bridge with `ORKESTRATOR_CLAUDE_ACCOUNT_HOME` (only when the copy's source is the `HOME/.claude.json` the bridge reads), and the bridge reports servers only the copy names as stale from launch and refuses their tools with their own reason (`claudeAccountOnlyMcpServerNames` in `mcp-config.ts`, `accountOnly` in `session-manager-prompt-mcp-sync.ts`). Codex accounts are unaffected (they link `config.toml`).
- **UI note.** While an added Claude account exists, the `claude:user` and `claude:local` sources carry the note "Added Claude accounts use their own copy of these servers. Orkestrator replaces each copy with this file's servers when you save here and before it starts Claude on an account, so servers added inside an account's own configuration are overwritten, and Orkestrator sessions do not use them." It shows in the source header above its servers (no renderer change).
- **Evidence.** A new `account` scenario in `session-manager-prompt-mcp-sync.live-probe.ts`, run by `mise run verify:claude:mcp-live` on the real CLI without credentials: the CLI never loads a host-only SSE server (it does not read the host file), the copy-only `extra` runs and is stale from launch, a host add loads and a host removal unloads in the running CLI. Unit tests: `mcp-config-account.test.ts`, `session-manager-prompt-mcp-sync.test.ts`, `service-claude-accounts.test.ts`, `agent-accounts-active.test.ts`, `McpStatusAndStates.test.tsx`. Documented in `docs/architecture/agent-accounts.md`.
- **Not proven.** No session on a real signed-in account ran (7568, 0039 task 12); the backend-to-bridge handoff is unit-tested. A host-file edit made outside the editor reaches an account's copy only at the next bridge launch or editor save (reported stale and refused meanwhile). Bridges launched before this change report nothing for account-only servers until they relaunch.

### 13. Claude MCP reconnect on a running CLI

**Problem.** A probe reconnect now takes its list from the probe and keeps the
`orkestrator` row, and a running CLI's report replaces the merged list. The
credential-free `mcpui-both` check cannot keep a CLI warm, so reconnect on a
running CLI has not been exercised (task 8).

**Context.** Moved from to-do 1163 (deleted 2026-11-06). `applyProbeMcpStatus`
and `session.mcpServerLayers` are in
`bridges/claude-bridge/src/services/session-manager-catalog.ts`; the layers come
from `getMcpRuntimeConfig` (`mcp-config.ts`). The credential-free check and its
hold-open hook are in `e2e/agent-testing/mcp-ui-matrix.spec.ts`.

**Investigation.** Steps:

1. Open a `dev:test --fixture` profile with a real Claude login. Give the
   environment a `.mcp.json` with one healthy and one failing server.
2. Send a turn the provider accepts, so the CLI stays warm. Fix the failing
   server and reconnect its row.
3. Check that the whole list comes from the live control, that the
   `orkestrator` row is kept, and that the layers read `project` and
   `orkestrator`.
4. Let the CLI exit (evict it or restart the bridge), run a probe reconnect,
   then send another turn. Check that the running CLI's report replaces the
   merged list, and that the list is still right after a reload.

**Decisions.**

- **Run it with task 6 or alone?**
  - **With task 6's corrected live probes on the same Claude login (recommended).**
    - Pros: one profile and one billed session.
    - Cons: waits for task 6.
  - **Alone.**
    - Pros: smaller run.
    - Cons: a second billed setup.

**Outcome (2026-11-06): run with a fake key and a loopback model.** Not with
a real Claude login: the ticket allowed none. A fourth case in
`mcp-ui-matrix.spec.ts`, "live panel: reconnect on a running CLI, then
through the probe after it exits (fake model)", opt-in with
`ORKESTRATOR_AGENT_TEST_MCP_UI=1` and `ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1`
and skipped on a profile with a Claude credential. It points the profile's
Claude settings at the scripted model for the case alone, so the turn
succeeds and the CLI stays warm. Run `mcp0039-fake-t13`: 1 passed, 619 s, at
1440×1000 (command in the
[fake-model record](#fake-model-live-record-2026-11-06)).

- **Warm CLI.** After one answered turn: `mcpui-ok` connected, `mcpui-late`
  failed, `orkestrator` connected, layers `project`, `project`,
  `orkestrator`; the panel read "1 down". The failing script was then
  created and the row clicked: reconnect 200, `mcpui-late` connected, and
  the probe log shows only `mcpui-late` started again while `mcpui-ok` kept
  its process, so the reconnect went through the live control, not a probe
  CLI. The whole list stayed the session's own, `orkestrator` kept, layers
  unchanged.
- **Panel live refresh: stale.** The open panel still read "1 down" with
  the row failed 30 s after the backend read `connected`. That is the 7221
  symptom on the live-control path too, not only after a probe; the case
  records it (annotation `panel-after-warm-reconnect`) and checks the panel
  after a hard reload instead, where it matched the backend. Added to
  7221 (closed 2026-11-09; see [After an MCP server action](../../architecture/native-transcripts.md#after-an-mcp-server-action));
  since then the case asserts the live refresh.
- **After the CLI exits.** The bridge released the idle CLI 10 minutes
  after the turn (both servers logged their exit). The session kept its
  last list (all three rows `connected`). A reconnect of `mcpui-late` then
  ran through the probe: the probe CLI started both servers once more, the
  answer changed no other row and kept `orkestrator`.
- **Next turn and reload.** The next turn's new CLI started both servers
  and its report replaced the list (same three rows, `connected`, same
  layers); after a hard reload the panel showed "3 servers", no "down", and
  each row's tool count as the backend.
- **Found on the way.** A bridge restart, which the step list allowed as a
  way to end the CLI, leaves the session with no live list at all, so a
  probe reconnect then has no row to keep and the panel nothing to click;
  the case waits for the idle release instead. The profile was restarted
  with `CLAUDE_BRIDGE_RUNTIME_IDLE_MS=90000` for this run, but the CLI was
  still released only after the default 10 minutes; why the variable did not
  shorten it was not investigated (the case waits up to 12 minutes).
  After the release the retained rows read `connected` with no CLI running;
  task 14 only covers rows left `connecting`.

### 14. Claude MCP rows read unknown after a refused CLI exits

**Problem.** When a Claude CLI exits before any status read reaches it, the
bridge now serves its retained `connecting` rows as `unknown`, on the session,
probe and closed-transport paths. Only unit tests prove it; the browser run
that found the frozen rows has not been repeated.

**Context.** Moved from to-do 1240 (deleted 2026-11-06). The change is
`inventoryWithoutCli` in
`bridges/claude-bridge/src/services/session-manager-catalog.ts`, tested in
`session-manager-catalog-transport.test.ts`. It was seen on a
`--no-agent-credentials` profile at host load about 4: the CLI stopped the
fixture server about 100 ms after starting it.

**Investigation.** Steps:

1. On a quiet host, open a
   `dev:test --fixture --no-agent-credentials --agent-platforms claude`
   profile.
2. Run `mcp-ui-matrix.spec.ts` (`ORKESTRATOR_AGENT_TEST_MCP_UI=1`) with its
   `UserPromptSubmit` hold-open hook removed, or by hand: `.mcp.json` servers
   and one turn that ends "Not logged in".
3. After the CLI exits, check that every live-panel row, `orkestrator`
   included, reads `unknown` and not `connecting`.
4. Open a row and check that reconnect is still offered and runs through the
   probe.

**Decisions.**

- **Make it a permanent spec case?**
  - **Add a no-hold variant to `mcp-ui-matrix.spec.ts` when this runs (recommended).**
    - Pros: the run repeats on every MCP change; needs no credentials.
    - Cons: depends on the CLI exiting before a read, which is timing-bound.
  - **Run it once by hand.**
    - Pros: no spec to maintain.
    - Cons: a regression would go unseen.

**Outcome (2026-11-06).** Built as recommended: a third case in
`mcp-ui-matrix.spec.ts`, "live panel: rows left connecting by a refused CLI
read unknown, and reconnect runs through the probe", opt-in with the rest of
the file (`ORKESTRATOR_AGENT_TEST_MCP_UI=1`, skipped unless the profile has
no Claude credential).

- **Making it deterministic.** Without the hold-open hook the race the step
  list describes depends on host load. Instead the case adds one project
  server, `mcpui-slow`, started with the probe server's new `--hold-file`
  option (`mcp-probe-server.mjs`, stdio only): while the file exists the
  server leaves the client's messages unread, so the CLI reports it
  `connecting`, waits its MCP connect timeout (about 30 s), ends the turn at
  the login check and exits with the row still `connecting`. The test checks
  that the worktree has no `.claude/settings.json` that could hold the CLI
  open, and that the CLI really started the held server.
- **Checks.** After the turn: the backend projection serves `mcpui-slow` as
  `unknown`, no row is `connecting`, `orkestrator` is present, and every
  panel row shows the backend's status with no "connecting" text; the row's
  own button still says "unknown — click to reconnect". Then the hold file is
  removed and the row clicked: the reconnect request answers 200, no turn
  runs, the probe starts the server again, the row becomes `connected` with
  its one tool, and no other row changes. After a hard reload the panel
  matches the backend again with no "connecting".
- **Runs** on `dev:test --profile mcp0039-t14 --fixture
  --no-agent-credentials --agent-platforms claude --headless`, host load
  about 10 to 13: the case passed in all 4 runs (one by an earlier attempt on
  this branch, three here; 76 to 82 s each). Final inventories:
  `mcpui-slow:unknown:project, orkestrator:connected:orkestrator` after the
  exit, `mcpui-slow:connected:project, orkestrator:connected:orkestrator`
  after the reconnect. Screenshots in
  `output/agent-testing/mcp0039-t14/mcp-ui-matrix/exit-*.png` (git-ignored).
  The profile was stopped and reset afterwards.
- **Found on the way.**
  - In two runs `orkestrator` read `failed` ("Server rejected the configured
    Authorization header (HTTP 401)"). The restarted profile's agent tools
    server had re-bound its saved port on `0.0.0.0` while another worktree's
    backend held the same port on `127.0.0.1`, so the CLI's requests reached
    that backend. A product defect, recorded as
    7220 (closed 2026-11-06; see [Port selection and the loopback address](../../architecture/container-lifecycle.md#port-selection-and-the-loopback-address-agent-tools-listents));
    resetting the profile (a fresh port) cleared it. This case only requires
    `orkestrator` to be present and not `connecting`, so it passed either
    way.
  - Task 8's case "reconnect a failing server beside a healthy one, then
    reload" fails at its reconnect step: the backend reads `mcpui-late`
    `connected` while the panel keeps it failed. It fails the same way with
    the spec at `HEAD` and on its own, so it predates this work and is not a
    flake: 7221 (closed 2026-11-09; see [After an MCP server action](../../architecture/native-transcripts.md#after-an-mcp-server-action)). The
    editor case passed in every run.
- The shared live-panel helpers of task 8's case moved into `liveSession`,
  `isMcpAction` and `describeServers` in the same file, so both cases use them.

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
  per probed tab), but its user-scope probes failed; a fake-model rerun on
  2026-11-06 passed both scopes, so the runtime side is shown, not a real
  model's. Grok is unrun.
- Apply-path guards (see "Runtime application" in
  [`mcp-management.md`](../../architecture/mcp-management.md)): every outcome
  names the runtime generation (bridge pid plus provider session) it was
  observed against; a bridge without the `mcpConfigReporting` marker is
  reported as one that does not report (`restart-required`); an edit made to the source after the save is merged
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
- Current pins (2026-10-31): Claude CLI 2.1.314, Codex 0.166.0, OpenCode
  1.19.5, Grok 1.0.70, Pi 1.4.0 (2026-10-25: Claude Agent SDK 0.3.309 / CLI
  2.1.309, Codex 0.164.0, OpenCode 1.19.4, Grok 1.0.67). The live records below
  used the earlier pins: Claude Agent SDK 0.3.296 / CLI 2.1.296, Codex
  0.162.1, OpenCode 1.19.0, Cursor SDK 1.0.37, Grok 1.0.52, Pi 1.2.0.
- Live probe spec: `e2e/agent-testing/mcp-apply-live.spec.ts` (opt-in,
  `ORKESTRATOR_AGENT_TEST_LIVE_MCP=1`) with the dependency-free probe server
  `e2e/agent-testing/mcp-probe-server.mjs`; the verdict rules have unit tests
  in `mcp-apply-live-support.test.ts`. Since 2026-11-06 every failed probe
  records the session's live inventory and a diagnosis (`diagnoseProbe`,
  task 5). `ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1` runs it, the inactive
  specs and task 13's UI case against the scripted loopback model
  `mcp-fake-model.ts` (Claude, Codex, Pi; no login). How to run it is under
  "Live apply record" and the fake-model record below.
- Outside edits for waiting runtimes no pass polls (OpenCode or container
  `restart-required`, sessions with nothing to poll) are re-checked by
  `external-edit-watch.ts`: once a minute per operation, four per tick, inside
  the 24-hour evidence window, retiring or flagging them as the evidence pass
  does. A Codex runtime whose app-server already reloaded the change is held
  and not watched, since it keeps the change until its next reload.
- Grok project trust (`grokFolderTrust` in `native-policy.ts`, `grokSources`
  in `providers.ts`) follows the pinned Grok 1.0.70, re-derived on 2026-10-31
  with `grok inspect` and `grok mcp doctor` in throwaway `GROK_HOME`s (task 2)
  and held by `mise run verify:grok:mcp-live`: the decision is the exact
  `[folders."<path>"] trusted = <bool>` entry for the repository root
  (symlinks resolved, trailing slash tolerated), and for a linked worktree its
  main checkout's; a grant on a non-git parent, on the worktree itself, on a
  nested repository's parent, or spelled through a symlink (`/tmp` for
  `/private/tmp`) does not count. The gate covers the project file,
  `.mcp.json`, `.cursor/mcp.json` and Claude's `projects[<repo>]` servers.
  `requirements.toml` servers outrank every other file. A session whose
  policy turns project resources on is `allowed`, because the ACP bridge runs
  Grok with `GROK_FOLDER_TRUST=0`. Containers already were.
- Codex project trust and same-name merging follow the pinned 0.166.0,
  checked with `codex mcp list` and held by `mise run verify:codex:mcp-live`:
  trust keys match exactly (no symlinked or trailing-slash spelling), and the
  winning row's status follows Codex's field-by-field merge
  (`codexMergedStatus`).
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
   them needs the CLI's enablement rules; that was 0121 (retired 2026-11-11;
   see "Claude plugins" in
   [`mcp-management.md`](../../architecture/mcp-management.md#recorded-discrepancies-and-provider-rules)).
8. **Replaced Claude server processes linger (blocked upstream).** Still true
   on CLI 2.1.319 (2026-11-11; first seen on 2.1.309): the live probe's new "replace" scenario edits a server under
   the same name and finds both processes alive, while only the new one is
   connected and offered. `session-manager-prompt-mcp-sync.live.test.ts` now
   asserts that, so it fails when the CLI starts stopping the old process;
   then expect one `alpha` and close this item. Not yet reported to
   Anthropic: filing moved to the manual-test checklist (7568) on
   2026-11-10; the standalone repro is written (task 1, 2026-11-11). Draft:
   "Claude Code 2.1.319, Agent SDK 0.3.319 `Query.setMcpServers`: replacing
   a stdio server's configuration under the same name connects a new process
   but never stops the old one when the old one was loaded at launch (the
   SDK's `mcpServers` option, or `mcpServers` in `.claude.json`); the old
   process keeps its environment until the CLI exits. A server first added
   through `setMcpServers` is stopped correctly when replaced. Repro:
   `bridges/claude-bridge/src/services/claude-mcp-replace-linger.live-probe.ts`
   (self-contained; `bun add @anthropic-ai/claude-agent-sdk`, then run it with
   `bun`; it exits 1 and prints the scenarios when it reproduces)."
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
  the user files are cached for the server's lifetime (apply now says so);
  the guard passes at 1.19.5 (2026-10-31). Grok: done for 1.0.70 on
  2026-10-31 (task 2). Codex: guarded since 2026-10-31 (task 3). Pi's two
  parity tests and Claude's live probe passed at the 2026-10-25 pins.
- **Grok and Pi live probes.** The Grok run (user and project scopes, saved
  `enabled`, SSE, with a current Grok login) moved to the manual-test
  checklist (7568) on 2026-11-10. Pi ran on
  2026-10-22 (see [the Pi record](#live-apply-record-pi-2026-10-22)): the
  project scope passed every probe; the user scope failed four, with the
  runtime `applied` while the model answered "unavailable" without a tool
  call. On 2026-11-06 a fake-model rerun at Pi 1.4.0 passed every probe in
  both scopes, so the rebuild offers the tool (task 5); a real-login rerun
  would only add model behaviour (7568, 0039 task 5). Claude, Codex, OpenCode and Cursor have
  historical observations, with the corrected-check gaps below.
- **Corrected live probes and completion matrix.** Rerun the busy-turn and
  negative tool-call checks, including Claude's warm SSE stale-server hook,
  under the corrected harness. The 2026-10-25 changes also need their first
  model-facing run: OpenCode project scope should now reach the new server
  with no restart (`applied` after the in-place reload) while the user scope
  keeps `restart-required`; Codex runtimes should turn `applied` after each
  tab's next turn; and the OpenCode rename's "old fails" probe should pass on
  the inventory when the model substitutes the new name. Claude, Codex and
  Pi ran on 2026-11-06 on a fake model and passed every cell, busy, negative,
  Claude's warm SSE hook and Codex `applied` included (task 6,
  [fake-model record](#fake-model-live-record-2026-11-06)); OpenCode ran on
  2026-11-10 on the same fake through a custom provider and passed both
  scopes: project scope `applied` by the in-place reload, user scope
  `restart-required`, and the renamed server's old name refused
  ([OpenCode record](#opencode-on-the-loopback-model-2026-11-10)). The
  Cursor and Grok runs need logins and moved to the manual-test checklist
  (7568) on 2026-11-10. Hand-seeding logins is no longer needed (see the
  isolation note in the 2026-10-18 method). The [completion matrix](#completion-matrix)
  retains the original observations and names the cells still unverified;
  provider errors, silence and substituted tools do not prove removal.
- **Inactive environment.** Claude's apply evidence and recovery checks passed
  on 2026-10-18 (see
  [the record](#qualification-record-inactive-environment-2026-10-18)): busy
  save, a cut event stream, reload, a bridge restart (newer generation), a
  removal, a pre-marker bridge and a shared user file. Full model-facing
  qualification remains open. Both parts below ran on 2026-11-06 on a fake
  model and passed (task 7); a real-model full run is still unrun (7568, 0039
  task 7).
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
  The rest of the UI matrix (conflict recovery and secret replacement at
  desktop and narrow widths; a healthy and a failing Claude server, reconnect,
  reload) passed on 2026-10-31 in `mcp-ui-matrix.spec.ts` (task 8); reconnect
  on a running CLI remains (task 13). On 2026-11-06 the same spec gained the
  refused-CLI `unknown` case (task 14, passing), and task 8's reconnect case
  went red with the panel left stale
  (7221 (closed 2026-11-09; see [After an MCP server action](../../architecture/native-transcripts.md#after-an-mcp-server-action))).
- **Containers and remote.** Moved to
  [0040](0040-mcp-environment-delivery.md) on 2026-11-06 (task 9): container
  targets are writable now and 0040 owns their qualification, and the remote
  browser check of host-target paths and operation recovery is part of
  0040's task 3.

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

## Fake-model live record (2026-11-06)

**Every run here is a fake-model run.** The pinned Claude CLI 2.1.314 (Agent
SDK 0.3.314), Codex 0.166.0 app-server and Pi 1.4.0 SDK, their bridges, the
backend, the browser UI and the probe servers ran for real; the model was
`e2e/agent-testing/mcp-fake-model.ts`, one Bun process on 127.0.0.1 serving
Anthropic Messages (Claude), the Responses WebSocket (Codex) and chat
completions (Pi). No login was used and no provider was called. The fake
calls a probed tool whenever the runtime offers it (Codex: from a code cell,
looking it up in `ALL_TOOLS`) and answers "unavailable" otherwise, so these
results show what each runtime offered, what the servers logged and what
apply reported. They are not evidence of how a real model behaves.

Host: macOS 27.2 (arm64), Bun 1.4.4, branch `mcp-management-3b93ef501ce9-r1`
from `ee2cc842`. One disposable profile, `mcp0039-fake`, with no Claude login
and a made-up Codex API key from a throwaway `CODEX_HOME` (git-ignored under
`output/agent-testing/`), so the profile received no real login; Pi used a
`models.json` provider whose key is a literal placeholder. The spec writes
the fake's address into the profile's own Claude `settings.json`, Codex
`config.toml` or Pi `models.json` before the environment starts and restores
them afterwards.

```bash
ORKESTRATOR_HOST_REACHABILITY_CHECK=off CODEX_HOME=<throwaway dir with a made-up API key> \
  mise run dev:test --profile mcp0039-fake --fixture --credential-source codex \
  --agent-platforms claude,codex,pi --headless
# Task 6 and 5, one provider per run:
ORKESTRATOR_AGENT_TEST_PROFILE=mcp0039-fake ORKESTRATOR_AGENT_TEST_RUN_ID=mcp0039-fake-<p> \
  ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1 \
  ORKESTRATOR_AGENT_TEST_MCP_PROVIDERS=<p> \
  ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=1800000 ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=3600000 \
  mise run test:logged -- --name mcp-fake-live-<p> -- bunx playwright test \
  --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/mcp-apply-live.spec.ts --workers=1
# Task 7 (add --trace off: a failed run's trace can exceed the 64 MiB sanitizer bound):
ORKESTRATOR_AGENT_TEST_PROFILE=mcp0039-fake ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 \
  ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1 mise run test:logged -- --name mcp-fake-inactive-<x> -- \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/mcp-apply-inactive[-codex].spec.ts --workers=1 --trace off
# Task 13 (profile restarted with CLAUDE_BRIDGE_RUNTIME_IDLE_MS=90000):
ORKESTRATOR_AGENT_TEST_PROFILE=mcp0039-fake ORKESTRATOR_AGENT_TEST_MCP_UI=1 \
  ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1 mise run test:logged -- --name mcp-fake-t13 -- \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/mcp-ui-matrix.spec.ts --grep "running CLI" --workers=1 --trace off
```

### Runs

| Task | Run | Result | Time |
| --- | --- | --- | --- |
| 6 Claude | `mcp0039-fake-claude`: user, private local, project, SSE | failed one check: warm SSE runtime `pending-next-turn` at save, `restart-required` after the probe turn (spec checked too early; corrected) | 490 s |
| 6 Claude | `mcp0039-fake-claude-sse`: SSE only, corrected check | 1 passed | 60 s |
| 6 Codex | `mcp0039-fake-codex`: user, project | 1 passed | 259 s |
| 5, 6 Pi | `mcp0039-fake-pi`: user, project | 1 passed | 292 s |
| 7 Claude | `mcp0039-fake-inactive`, full mode, pre-marker step attempted | failed at that step: the 65077337 bridge could not authenticate (401), see task 7 | 174 s |
| 7 Claude | `mcp0039-fake-inactive`, full mode, without the pre-marker step | 1 passed | 166 s |
| 7 Codex | `mcp0039-fake-inactive-codex`, new process-wide spec | 1 passed | 54 s |
| 13 | `mcp0039-fake-t13`, first attempts: panel check before the reload; then a bridge restart to end the CLI | failed: panel stale (7221); after a bridge restart the session listed no servers, so a probe reconnect had nothing to keep | 6 min each |
| 13 | `mcp0039-fake-t13`, final case (idle release instead of a restart) | 1 passed | 619 s |

Earlier attempts failed for harness reasons fixed before the runs above:
the fake model first missed Codex's tools (offered on a prewarm frame) and
then did not know Codex's code mode, and the inactive spec clicked under a
late "Claude Code Is Not Logged In" notice (a locator handler now closes it).

### Matrix (fake model)

Every probe below passed; "reached" means the probe server logged the call
with the probe's nonce, "fails" means it logged none and the turn replied
unavailable. Apply outcomes are per tab A, B.

| Provider · scope | Add | Edit (A, B) | Rename (new / old) | Remove (A, B) | Busy | Restart and restore | Apply outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude · user `~/.claude.json` | reached | reached v2 both | answers / fails | fails both | passed: `sleep 45` seen running, turn ended `BUSY-DONE` | reached after bridge restart | `pending-next-turn`, then `applied` per tab after its turn |
| Claude · private local | reached | reached v2 both | answers / fails | fails both | — | — | same |
| Claude · project `.mcp.json` | reached | reached v2 both | answers / fails | fails both | — | — | same |
| Claude · SSE in `.mcp.json` (outside the editor) | reached after a bridge restart | — | — | fails on the warm CLI: hook refused the call, server logged none, same bridge and session | — | — | warm tab `pending-next-turn` at save, `restart-required` after that turn; idle tab `pending-next-turn` |
| Codex · user `config.toml` | reached | reached v2 both | answers / fails | fails both | passed | reached after bridge restart | `queued`, `pending-next-turn` after the reload, `applied` per thread after its turn |
| Codex · project `.codex/config.toml` (trusted) | reached | reached v2 both | answers / fails | fails both | — | — | same |
| Pi · user `~/.pi/agent/mcp.json` (profile home) | reached | reached v2 both | answers / fails | fails both | passed | reached after bridge restart | `pending-next-turn`, then `applied` per tab after its turn |
| Pi · project `.pi/mcp.json` | reached | reached v2 both | answers / fails | fails both | — | — | same |
| OpenCode | run on 2026-11-10: see [OpenCode on the loopback model](#opencode-on-the-loopback-model-2026-11-10) | | | | | | |
| Cursor, Grok | not run: both need a login | | | | | | |

Evidence: `output/agent-testing/mcp0039-fake-*/mcp-apply-live/<provider>.json`
and the runs' Playwright reports, in this worktree (git-ignored). The
profile was stopped and reset afterwards, and every environment the runs
created was deleted by the specs.

## OpenCode on the loopback model (2026-11-10)

**A fake-model run.** The pinned OpenCode 1.19.5 server, its bridge
wiring, the backend, the browser UI and the probe servers ran for real; the
model was `mcp-fake-model.ts` on 127.0.0.1, reached through a custom
OpenCode provider (`@ai-sdk/openai-compatible`, which OpenCode bundles) that
`opencode-fake-provider.ts` merges into the profile's own global
`opencode.json` (`<dataDir>/agent-credentials/xdg-config/opencode/`). The
merge keeps the file's MCP servers, sets the provider as `model` and
`small_model`, and limits OpenCode to it (`enabled_providers`), so no turn or
title request could reach a hosted model. Orkestrator's own provider
allowlist (`openCodeModelProviders`, default `opencode` and `opencode-go`)
treats a connected provider outside it as signed out, so the spec adds the
fake's provider to the profile's setting for the run and restores it after.
The fake recognises OpenCode's `<server>_<tool>` tool names (read from the
1.19.5 binary's own sanitizer) and adds the description OpenCode's `bash`
requires.

Host: beelink (Arch Linux, kernel 7.1.8, no display), Bun 1.4.4, branch
`20261110-091903-4e2607b3a830` from `c98b20e6f`. One disposable profile,
`oc-loop-0039`, started with no host credentials and only OpenCode enabled;
no Docker container was created.

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" \
  PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
  mise run dev:test --profile oc-loop-0039 --fixture --no-agent-credentials \
  --agent-platforms opencode --headless
ORKESTRATOR_AGENT_TEST_PROFILE=oc-loop-0039 ORKESTRATOR_AGENT_TEST_RUN_ID=oc-loop-0039-mcp \
  ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1 \
  ORKESTRATOR_AGENT_TEST_MCP_PROVIDERS=opencode MCPQ_FAKE_SHAPES=1 \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/mcp-apply-live.spec.ts --workers=1 --reporter=line --trace off
```

| Provider · scope | Add | Edit (A, B) | Rename (new / old) | Remove (A, B) | Busy | Restart and restore | Apply outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenCode · user `opencode.json` (profile `XDG_CONFIG_HOME`) | reached after restart | reached v2 both | answers / fails | one call still answered before the restart (recorded), then fails both | passed: `sleep 45` seen running, turn ended `BUSY-DONE` | reached after bridge restart | `restart-required` at every save, as decided in task 11 |
| OpenCode · project `opencode.json` | reached | reached v2 both | answers / fails | fails both | — | — | `queued`, then `applied` by the in-place reload, no restart |

Evidence: `output/agent-testing/oc-loop-0039-mcp/mcp-apply-live/opencode.json`
in the worktree that ran it (git-ignored). One sample. The spec deleted its
environment, restored the profile's `opencode.json` and allowlist, and the
profile was stopped and reset afterwards. Its `dev:stop` left a 1 GB
Electron core file in the worktree, the known
[7554](../cross-cutting/7554-headless-dev-electron-core-dumps-in-checkout.md);
it was deleted and not committed.

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

- **Isolation.** Superseded since `d4171748` (#1116, 2026-10-21): every
  agent-test profile has its own `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and XDG
  directories and receives only a restricted snapshot of an authorised login,
  so no hand-seeding is needed; the 2026-11-06 fake-model runs used no login
  at all. As it was on 2026-10-18: an agent-test profile pointed `CODEX_HOME` and the XDG
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
injected `orkestrator` servers, and every container target (read-only at the
time; container targets are writable since 0040, which owns their
qualification). Cursor's project scope without the policy override stays excluded
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
  reload changes; Claude's running-CLI behaviour has `verify:claude:mcp-live`;
  Codex and Grok have `verify:codex:mcp-live` and `verify:grok:mcp-live`
  (since 2026-10-31).
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
- Resolved 2026-11-06 (task 11): no explicit, idle-gated "restart OpenCode
  to apply" for the user files. A server restart drops every pending question
  and permission in the environment, which is a bigger step than apply has
  taken so far; user-file saves keep `restart-required` with guidance, and
  the OpenCode upgrade step reruns `verify:opencode:mcp-live`, which fails if
  a bump stops caching the user files.

## Needs verification

- ~~How OpenCode OAuth completes after `mcp.auth.start`.~~ Traced 2026-10-25:
  it does not (see the OpenCode 1.19.4 record). ~~Whether
  `mcp.auth.authenticate` could be driven from the panel.~~ Dropped
  2026-11-06 (task 11): it opens the browser on the server's machine and
  holds the request up to 5 minutes, which is wrong for remote browsers and
  containers, so the CLI guidance route stays and this is not verified.
- ~~Whether Grok 1.0.67 still follows the 1.0.52 trust rule and source
  table.~~ Checked 2026-10-31 at the new pin 1.0.70 (task 2): the trust rule
  and precedence hold; the catalogue gained `requirements.toml` sources, the
  store-shape rule and trust on Claude's private entry.
- ~~Agent-account homes: when a running Claude account session sees an
  editor write, the UI note, and stale reporting for account-only servers.~~
  Done 2026-10-31 (task 12), proven on the real CLI without credentials; a
  session on a real signed-in account is still unrun (7568, 0039 task 12).

## Assumptions and decisions

### 2026-11-11: task 1, the standalone repro

Made without stopping to ask. No login, no model request and no outward
action: the report itself stays with the maintainer (7568).

#### Task 1: one self-contained file, kept in the bridge

Chose a single TypeScript file that imports only the Agent SDK and Node
built-ins and serves as its own fixture MCP server, placed beside the
existing probe and run by the existing live test. The alternatives were a
script outside the source tree (not typechecked or run, so it could silently
stop reproducing) or pointing the report at the internal probe (it imports
bridge modules, so an outside reader cannot run it). Keeping it under
`src/services/` with the `.live-probe.ts` suffix gets it typechecked and
lint-exempt for `console`, and the second live test fails when it stops
reproducing.

#### Task 1: three load paths instead of one

The internal probe's `replace` scenario loads the server both inline and
from `.claude.json` at once, so it could not say which path leaks. The repro
loads it each way separately, which showed that a server added through
`setMcpServers` is stopped correctly. That narrows the report and keeps the
upstream fix easy to verify; the canary itself is left as it was.

#### Task 1: the toolchain came from a throwaway data directory

This shell's `CLAUDE_CLI_PATH` points into the real data directory's
toolchains, which this work was not allowed to touch. The direct repro runs
used the pinned 2.1.319 installed with
`mise run toolchain:install --data-dir <worktree>/output/p0039/toolchain-data
--tool claude`, removed afterwards. The first two `mise run
verify:claude:mcp-live` runs did not: they inherited `CLAUDE_CLI_PATH` and
executed the host's binary from the real data directory (read-only,
temporary `HOME` and `CLAUDE_CONFIG_DIR`, no prompt; see task 1's
disclosure). That cannot be undone; none of the recorded evidence comes from
those runs. The recorded `verify:claude:mcp-live` and
`verify:claude:plugin-mcp-live` results are reruns with `CLAUDE_CLI_PATH` at
a second throwaway install (`output/p0039-r2`, removed afterwards) and every
variable naming the real data directory unset. Anyone rerunning these tasks
under the same constraint should set `CLAUDE_CLI_PATH` the same way, because
both live tests take the executable from it.

### 2026-11-10: task 6, OpenCode on a loopback model

Made without stopping to ask. No login and no billed turn: the one live run
used the loopback fake model.

#### Task 6: how OpenCode reaches the fake

Options: (a) a custom provider in the profile's own global `opencode.json`,
served by the AI SDK `@ai-sdk/openai-compatible` package OpenCode bundles,
pointing at the fake's existing chat-completions route; (b) the same
provider in `OPENCODE_CONFIG_CONTENT`, as the backend's OpenCode live tests
do; (c) a project `opencode.json` in the worktree. Chose (a). Pros: the
backend starts OpenCode with the profile's `XDG_CONFIG_HOME`, so nothing in
the launch path changes; it is the file the spec already snapshots for the
MCP user scope, so one restore covers both; no package download. Cons: it
shares the file with the user-scope MCP editor, so the merge must keep every
other key (it refuses a JSONC file rather than drop a comment). (b) would
need a backend environment change for one test, and the MCP editor would
then report an extra read-only source; (c) would mix the provider into the
project scope this task probes.

#### Task 6: the allowlist is opened for the run, not changed in code

The first run skipped: the composer asked for a sign-in, because
Orkestrator's `openCodeModelProviders` allowlist (default `opencode` and
`opencode-go`) counts a connected provider outside it as signed out. That is
the designed behaviour of a setting the user controls, so it is not a
defect: a user with a custom provider adds it in settings. Options: (a)
patch the profile's setting for the run through `patch_global_config` and
restore it; (b) also admit any provider named in the user's `opencode.json`
automatically. Chose (a): it is what a user does, and (b) would widen a
deliberate allowlist without a product decision.

#### Task 6: limiting OpenCode to the fake's provider

`enabled_providers` holds only the fake's provider, and it is also the
`small_model`, so OpenCode's own title and summary requests cannot fall
through to its hosted free models. Cost: none for the probes, which never
need another provider.

### 2026-11-06 review repairs: tasks 7, 13 and qualification harness

**Task 7: count actual reload requests.** The Codex inactive scenario now
wraps only the disposable profile's activation symlinks with a stdio tap
that forwards requests to the real pinned app-server. It records only the
working directory of `config/mcpServer/reload` requests, never request bodies.
The add and removal each require exactly one request, both after apply settles
and after the two thread turns. Counting bridge PIDs would miss repeated
reloads within that bridge. The original activation links are restored during
cleanup, after the fixture environments stop.

**Task 13: distinguish retained inventory from a fresh report.** While the
Claude CLI is stopped, the case saves removal of `mcpui-ok` without applying
it. The probe reconnect must retain that row while changing only its target.
The next real CLI report must remove `mcpui-ok`; the backend and reloaded panel
must then show two servers. The original recorded run earlier in this document had three identical
rows before and after the next turn; it established continuity but did not
prove replacement. This stricter case addresses that coverage gap. The idle-release poll emits
a content-free progress line every 30 seconds: the initial logged rerun was
killed by the runner's five-minute silence watchdog while waiting for the
real ten-minute idle window. The wait retains its existing deadline.

**Tasks 5, 6, 7 and 13: harness coverage.** Direct loopback tests cover Messages and chat SSE tool
arguments, stop reasons and final replies, plus Responses WebSocket prewarm,
remembered tool offers, continuations and replacement offers. Profile wiring
tests cover all three providers, exact restoration of existing bytes and modes,
removal of newly created files, refusal of unrelated Pi providers, invalid
configuration cleanup and the inside-profile path guard. These complement the
opt-in real-runtime cases without requiring a login or billed request.

**Task 14 record.** Restored the missing task heading before its Problem
paragraph; the task status and existing evidence are unchanged.

**Review validation.** The direct suite has 27 passing tests (13 added). The
strengthened Codex inactive scenario passed on profile `mcp-review-fixes`
(80.8 s including the task runner); its marker recorded two reload RPCs in
all, and both profile activation links were restored. The strengthened Claude
reconnect scenario then passed with the distinct inventories (655.8 s including
the task runner), after adding progress output and rerunning the exact command
that first hit the silence watchdog. Focused e2e typechecking,
lint and formatting passed. The original preparation's broad red checks were
not rerun: the source-guard failure has target-branch CI evidence; the other
full-suite and browser failures remain undetermined in the captured triage
and are left to the verifier, rather than attributed to the test-only diff.

### 2026-11-06: tasks 5, 6, 7, 9 and 13 with fake models

Made without stopping to ask. The ticket allowed no login and no billed
turn, so every live run used a fake model; that is the one assumption all of
these share.

#### Tasks 5, 6, 7 and 13: one MCP-aware fake for three protocols

Options: (a) extend the idle-observation fakes (Claude and Codex) and the
soak's Pi fake separately; (b) one scripted model that serves Anthropic
Messages, the Responses WebSocket and chat completions from one process,
reusing those fakes' framing helpers. Chose (b), `mcp-fake-model.ts` with its
pure script in `mcp-fake-model-script.ts` and profile wiring in
`mcp-fake-model-wiring.ts`: the probe logic (find the probed server's tool,
call it, answer from its result, else "unavailable") is the same for every
provider, so it is written and unit-tested once (`mcp-fake-model.test.ts`).
Cost: one more fake to keep in step with three wire formats.

#### Tasks 5 and 6: the fake always calls an offered tool

Options: (a) a fake that sometimes does not look, to resemble a model;
(b) one that always calls an offered tool. Chose (b): it turns a probe into
a test of the runtime (was the tool offered, did the server log the call,
did apply say so), which is the half a fake can prove. It cannot show a
model ignoring a tool, so every run is labelled a fake-model run and task 5
claims only the runtime half.

#### Task 6: Codex code mode through `ALL_TOOLS`

Codex 0.166 offers only `exec` (code mode); MCP tools are on `tools.*`, and
its own description says to find nested tools in `ALL_TOOLS`. The fake's code
cell looks the probed name up there and prints `MCPQ-NO-TOOL` when it is
missing, so a removed server is never called. Alternative: call
`tools.<name>` and treat an exception as absence; rejected, because a
thrown error could also be a failing server.

#### Task 6: when the warm SSE runtime must say `restart-required`

The spec required it right after the save; it appears only after the next
turn, because the bridge learns a server is stale at that turn's sync
(evidence rule 5 in `evidence.ts`). Options: (a) treat the run as a product
failure; (b) judge it after the probe turn. Chose (b), keeping the expected
state: before the turn the runtime must not claim `applied`, after it
`restart-required`. The warm-CLI checks (same bridge pid and session, call
refused by the hook, server logged nothing) are unchanged.

#### Task 7: the pre-marker bridge step

Options: (a) keep trying to run it with a bridge from `65077337`; (b) record
it as no longer runnable. Chose (b): every published release since the
v2.21.0 floor has the `mcpConfigReporting` marker, and a source build that
predates it cannot authenticate with today's backend (401 since the
2026-11-04 bridge credential verifier), so the step tests a peer outside the
support window. The optional step stays in the spec; removing the backend's
pre-marker handling falls under the
[support window](../../architecture/version-compatibility.md#the-support-window)
rules and was not done here (product code outside this ticket).

#### Task 7: a separate Codex spec

Options: (a) a parameterised mode of the Claude inactive spec (the
recommendation); (b) its own spec sharing the fixture server. Chose (b),
`mcp-apply-inactive-codex.spec.ts` with `FIXTURE_SERVER` moved to
`mcp-apply-inactive-support.ts`: the Claude spec is built around Claude
(its composer, the private local scope, the pre-marker bridge, a bridge
restart), while the process-wide case needs two threads on one bridge and
the per-thread evidence. Sharing the fixture keeps the call markers
comparable. Cost: two specs to keep in step.

#### Task 13: ending the CLI by idle release, not a bridge restart

The step list allowed either. A bridge restart leaves the session with no
live list, so a probe reconnect has no row to keep and the panel nothing to
click. Chose to wait for the bridge's idle release (seen from the probe
servers' own exit lines), which takes the default 10 minutes. Cost: a
10-minute case, opt-in.

#### Task 13: the panel's live refresh is recorded, not asserted

The open panel stayed stale after the live-control reconnect, as in 7221.
Options: (a) assert it, leaving this case red like task 8's; (b) record it
and assert the panel after a reload. Chose (b): the case's own claims (whole
list from the live control, `orkestrator` kept, layers, the probe path, the
next turn's report, the reload) all hold, and the stale panel is already
tracked and kept red in task 8's case; 7221 now has this case as evidence
and the note to tighten it once fixed. Superseded 2026-11-09: 7221 is fixed
and the case asserts the live refresh (option a).

#### Task 9: where the remote host-target check lives

Chose the recommended option: close it here and move the part 0040's task 3
did not cover (host-target paths and operation recovery from a remote
browser) into that task as a second check of the same two-machine run.

#### Tasks 1, 4, 10 and the rest of 6: left open

Task 1 needs an outward-facing report, task 4 a Grok login, task 10 a
release decision; Cursor needs a login, and no OpenCode fake was built
because the ticket covered Claude, Codex and Pi (built on 2026-11-10, see
below).

### Task 13: retirement pointer (2026-11-06)

Keep the completed 1163 fix historical and direct its live running-CLI check to
task 13 here; deleting the old implementation file does not close that check.

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
| Unmodelled layers (item 7) | (a) model every layer; (b) model only layers with a passive reader | (b): only Claude plugins qualify, and they need the CLI's enablement rules, so they moved to their own file (0121, retired 2026-11-11) | No guessed sources; the live join already labels such rows | Plugin servers stay visible only in the live panel for now |
| Live row join (item 5) | (a) name only (as before); (b) name, scope and target; (c) also by runtime | (c): exact name and target, live scope picks the source, then effective status and precedence; the session's apply outcome by `runtimeId` | One highlighted row; explains injected, plugin and unknown rows | Pi's sanitized names are matched by rule, which must track the bridge |
| Count-only MCP tiles (item 6) | (a) delete; (b) show only when no list is reported | (b): an older bridge that reports only the count still shows something | No duplicate number beside the list | Two code paths |
| Rename probe (item 12) | (a) a tool name the model cannot substitute; (b) pin another model; (c) accept a substitution when the runtime's inventory proves the old name gone | (c): a renamed process keeps its label and tool, so (a) cannot work; (b) breaks when the model changes | Absence is proven by the runtime, not by the model's choice | Needs the session to report an inventory (OpenCode does) |
| Item 8 report | (a) file it with Anthropic now; (b) draft it and pin the behaviour | (b): filing is outward-facing; the canary tells us when it is fixed | Nothing published without a maintainer | Still unreported |

### 2026-11-06: tasks 5, 11 and 14

Made without stopping to ask, following the (recommended) options unless
noted.

#### Task 14: a hold file instead of the race

The step list relied on the CLI exiting before a status read reached it,
which depends on host load (the 1240 run saw it at load 4). Options: (a) run
without the hold-open hook and hope the exit wins; (b) hold one server
`connecting` until after the exit. Chose (b), a `--hold-file` option on the
probe server: stdin stays unread while the file exists, so the CLI reports
the server `connecting` and exits before it can connect, and removing the
file lets the probe reconnect succeed. It makes the case deterministic and
also gives the reconnect a server that changes state. Cost: the turn waits
out the CLI's MCP connect timeout (about 30 s per run).

#### Task 14: what the `orkestrator` row must read

The step list says every row, `orkestrator` included, must read `unknown`.
The injected server connects over HTTP at once, so it reads `connected`; it
was never left `connecting`. The case asserts what the fix guarantees: no row
is `connecting`, the held row is `unknown`, and `orkestrator` is present.

#### Task 14: helpers shared with task 8's case

Moved task 8's live-panel helpers (`liveSession`, `isMcpAction`,
`describeServers`) to file scope rather than copying them, so both cases
expand, click and compare the panel the same way.

#### Task 14: follow-ups instead of fixes

Two faults found during the runs are outside this ticket and touch other
areas (the agent tools server, the renderer's projection refresh), so they
are recorded rather than fixed:
7220 (closed 2026-11-06; see [Port selection and the loopback address](../../architecture/container-lifecycle.md#port-selection-and-the-loopback-address-agent-tools-listents))
(High: a scoped bearer token reaches another process) and
7221 (Medium; closed 2026-11-09, see [After an MCP server action](../../architecture/native-transcripts.md#after-an-mcp-server-action)).
Task 8's spec case was left as it was, red until 7221 was fixed, rather than
loosened; it passes since the fix.

#### Task 5: read the inventory on every failed probe

Options: (a) read it only for a reach probe that logged no call (the Pi
failure); (b) read it for every failed probe. Chose (b): one projection read
per failure costs nothing on a passing run, and a diagnosis for every failure
kind helps all six providers. The verdict is judged again with the
inventory, so the existing substitution rule (item 12) still applies.

#### Task 5: no Pi rerun

The Pi rerun needs a real Pi login and billed turns, which this work was not
allowed to use. What it needs is recorded under task 5.

#### Tasks 5 and 14: review corrections (2026-11-06)

Task 5 now passes the turn error into `diagnoseProbe`. Chose a distinct
`turn-failed` classification before interpreting inventory, while keeping a
logged server call authoritative as `reached`. Keeping inventory-only
classification would preserve the old labels, but could blame the model for a
dispatch, provider or no-progress failure. Unit cases cover each error kind,
missing inventory, negative expectations and a reached server followed by an
error. Error text is not copied into the diagnosis.

Task 14's hold-file server now reads and buffers at most 1 MiB while deferring
responses. Keeping stdin paused avoided a fixture buffer, but could not
observe EOF and left the polling process alive when its client closed. Direct
process tests cover silence while held, the buffered response after release,
and exit on EOF both with and without buffered input. These tests live in
`mcp-probe-server.integration.test.ts` and use only their own child handles for
cleanup.

The first review run with EOF handling read `failed` rather than `unknown`:
Claude waited out its 30 s MCP connection deadline before refusing the turn.
The task 14 fixture now sets `CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0` in its own
project settings, as documented in
[the SDK connection timing guide](https://code.claude.com/docs/en/agent-sdk/mcp#connection-timing).
The disposable profile also sets the existing
`CLAUDE_BRIDGE_RUNTIME_IDLE_MS=0` control, because the default keeps the CLI
warm for ten minutes. The profile supplies the startup-wait variable too,
so the SDK sees it at process launch. No hold-open hook or credentials are
added, and the `unknown` assertion is retained. Keeping the defaults would
test a warm runtime and a failed connection rather than the exited-CLI
pending-connection fallback this case owns.


Review validation on this worktree (all through `test:logged` where applicable):

- Helper and process tests: `bun test
  e2e/agent-testing/mcp-apply-live-support.test.ts
  e2e/agent-testing/mcp-probe-server.integration.test.ts --parallel=1` passed.
- `bun check -p e2e/agent-testing/tsconfig.json`, focused `bun fmt --check`
  and focused oxlint passed for the changed harness files.
- Task 14: **1 passed, 0 skipped**, 79.7 s, at 1440×1000 against the real
  isolated profile `mcp0039-review-fix`. The profile used
  `CLAUDE_BRIDGE_RUNTIME_IDLE_MS=0 CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0`,
  `--fixture --headless --no-agent-credentials --agent-platforms claude`.
  The exact test invocation was
  `ORKESTRATOR_AGENT_TEST_PROFILE=mcp0039-review-fix
  ORKESTRATOR_AGENT_TEST_RUN_ID=mcp0039-review-fix
  ORKESTRATOR_AGENT_TEST_MCP_UI=1 mise run test:logged -- --name
  mcp-findings-task14 -- mise run test:agent:browser --
  e2e/agent-testing/mcp-ui-matrix.spec.ts --grep 'rows left connecting'
  --workers=1`. Its JSON report is
  `output/agent-testing/mcp0039-review-fix/browser/results.json`; annotations
  record `mcpui-slow:unknown`, reconnect 200, then `mcpui-slow:connected`,
  with `orkestrator:connected` unchanged. Reload assertions also passed.
- Two earlier attempts with the default warm-runtime lifetime failed the
  `unknown` assertion and then exceeded the trace sanitizer's 64 MiB limit.
  Their separate compressed logs remain under
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.1R2MIZ/`
  and `orkestrator-test-run.ChH1WS/`, and browser reports are copied to
  `output/agent-testing/mcp0039-review-fix-attempt1/` and `-attempt2/`.
  The same command passed after the profile lifetime correction; assertions
  and sanitizer limits were not loosened. The profile was stopped and reset.
- The preparation run of `mise run test:agent:browser:isolated` remains
  unresolved: three assertions in unchanged gateway, CLI UI and terminal
  resume specs, followed by the 1500 s runner timeout. The original review
  package's triage marks the command `unattributed: true` and supplies no
  unrelated verdict. No path in those reported failures is changed here;
  their relation to the ticket cannot be established from the diagnostics.
  This broad failure is left for the verifier, without claiming it passed
  or excusing it as environmental. Original package and logs are preserved.

#### Task 11: decisions taken, no code

Both recommended options keep shipped behaviour, so nothing in the product
changed. The decisions are recorded in the task, in "Open questions" and
"Needs verification", and in `docs/architecture/mcp-management.md` (OpenCode
reload and OpenCode MCP sign-in), where a maintainer changing that code will
see them. No reason against either option came up.

### 2026-10-31: tasks 2, 3, 8, 11 and 12

Made without stopping to ask, following the (recommended) options unless
noted.

#### Task 2: how to read the Grok rules

Chose the recommended `grok inspect` method, extended with `grok mcp doctor`
and `grok mcp list`, on the pinned 1.0.70 installed into a throwaway data
directory (not the operator's toolchains or `~/.grok`), plus a diff of the
user guide the binary unpacks. `doctor` was the one surface that shows the
trust gate applying to MCP servers without a login; `inspect` alone could not.
Reading the compiled binary's source was not needed.

#### Task 2: catalogue fixes found by the re-derivation

Fixed rather than documented: the trust-store shape (other shapes were
counted as grants Grok does not honour), trust on Claude's private entry (an
untrusted folder's server was shown as loading), and `requirements.toml` as
a source (a pinned server was shown as overridden by the user's own). Each
makes a row claim less than before or name the real winner; none changes
what is written. Alternative: leave them and record the gaps; rejected
because each misstates which server runs.

#### Task 2: undecided trust stays `unknown`

`grok mcp doctor` treats an undecided folder like a declined one, so the
catalogue could say `excluded`. Kept `unknown`: an interactive Grok asks for
trust, and the ACP session's behaviour is task 4's open question.

#### Task 3: guard shape and reference command

Chose the recommended credential-free opt-in tests with `verify:*` tasks.
For Codex the reference is `codex mcp list --json` rather than an app-server
`config/read` or `mcpServerStatus/list`: it needs no JSON-RPC client, starts
no server, and uses the same loader. For Grok, `inspect` for trust and
precedence, `doctor` for the gate, `mcp list` for saved enable, because
`inspect` still lists `disabled_mcp_servers` names. Each test compares with
the catalogue's own functions and `summarizeEntries`, not with hard-coded
expectations, so it fails when either side moves.

#### Task 3: fix the Codex mismatches the guard found

The guard found two Codex rules the catalogue mirrored wrongly (exact trust
keys; field-by-field merge of `command` and `enabled`). Options: (a) fix
both; (b) mark the cases `test.failing` and write a follow-up; (c) loosen the
guard. Chose (a): both are small and contained (`codexProjectTrust`, and
`codexMergedStatus` touching only the winning Codex row's status and
`enabled`), and one of them showed a server as running that Codex keeps off.
Edit actions on a partial entry are unchanged (the form still requires a
command, so editing one writes a full entry).

#### Task 3: OpenCode guard harness

Found while checking task 11: `verify:opencode:mcp-live` failed on this host
at 1.19.4 and 1.19.5 because a request to a booting `opencode serve` can
hang and the poll had no timeout. Bounded every call (15 s) and widened the
readiness deadline to 60 s. Not recorded as a flake: it failed every time
when run alone, so it was a harness bug.

#### Task 8: a spec instead of the hand-walk

Options: (a) the recommended hand-walk with screenshots: cheap, no
regression protection; (b) a Playwright spec: more work, repeatable. Chose
(b), against the recommendation, because the cost the to-do named turned out
small: no credentials are needed (the Claude CLI reports MCP servers before
the login failure), and the failing server is a script created later. The
spec is opt-in (`ORKESTRATOR_AGENT_TEST_MCP_UI=1`) and its live case skips
unless the profile lists no Claude credential source, because the default
real-stack suites run with credentials and must never start a turn there.
Cost: an opt-in spec can drift unless someone runs it.

#### Task 8: the probe-reconnect inventory defect is a follow-up

Not fixed here: it is in the Claude bridge's MCP catalogue code
(`session-manager-catalog.ts`), outside the matrix, and was found while task
12 was changing neighbouring bridge files. Recorded as 1163 with a
recommended merge of only the acted-on row.

#### Task 8: launcher `NODE_ENV` fix

Fixed in place: a one-condition change limited to development and
agent-test profiles that blocked every local agent tab in a profile started
from an agent shell. Production profiles keep their `NODE_ENV`.

#### Task 11: recommendation only

Left open as instructed; recommended keeping `restart-required` and the CLI
sign-in route (see the task).

#### Task 12: how editor saves reach account sessions

Options: (a) document only; (b) have the bridge read the account's copy;
(c) refresh every account copy after each editor save and report copy-only
servers as stale; (d) re-sync before every prompt dispatch; (e) the bridge
re-syncs before each CLI launch. Chose (c): smallest change that is correct
for editor saves and never reports a false `applied`. (b) would delay saves
to the next bridge launch and change behaviour for users with their own
`CLAUDE_CONFIG_DIR`; (d) puts a file lock on the dispatch path; (e) gives the
bridge write access to account homes. Cost: an outside edit of the host file
waits for the next launch or editor save (stale and refused meanwhile).

#### Task 12: copy-only servers are stale and refused

Options: report only, or report and refuse their tools like any stale server.
Chose refuse, so stale has one meaning; the refusal says to add the server to
the user's Claude configuration. Cost: a server added with `claude mcp add` in
an account terminal is unusable in Orkestrator sessions, though it was
already wiped at the next launch.

#### Task 12: which bridges get it, and where the note goes

Only bridges the backend marks (`ORKESTRATOR_CLAUDE_ACCOUNT_HOME` equal to
`CLAUDE_CONFIG_DIR`) and only when the copy's source is the file the bridge
reads, so a user's own `CLAUDE_CONFIG_DIR` is never treated as a copy. The
note is backend text on the `claude:user` and `claude:local` sources, shown
only while an added Claude account exists. Alternatives were appending it to
every Claude capability text, writing it in the web app, or putting it on the
Accounts page; the source header is where those servers are edited.

#### Task 12: no follow-up to-do

The to-do recommended a follow-up for account-only stale reporting; done here
instead because it fitted in the same bridge change.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1's upstream report filing, task 4, task 6's Cursor cells, task 10) moved there on 2026-11-10, and the container session half of retired 0121 task 1.
- [Port selection and the loopback address](../../architecture/container-lifecycle.md#port-selection-and-the-loopback-address-agent-tools-listents)
  in `container-lifecycle.md`: the fix for the agent tools port clash found
  under task 14 (todo 7220, closed 2026-11-06).
- [After an MCP server action](../../architecture/native-transcripts.md#after-an-mcp-server-action)
  in `native-transcripts.md`: the fix for the stale live panel found under
  task 14 (todo 7221, closed 2026-11-09); task 8's reconnect case passes again.
- 0121 (retired 2026-11-11), the read-only Claude plugin source split from
  item 7: its rules and evidence are under "Claude plugins" in
  [`mcp-management.md`](../../architecture/mcp-management.md#verification-status),
  and its container session half is a 7568 item.
- [0040-mcp-environment-delivery.md](0040-mcp-environment-delivery.md) for containers,
  remote backends and environment-private configuration.
- [0003-agent-accounts-and-sign-in.md](../agent-engines/0003-agent-accounts-and-sign-in.md) and
  [`agent-accounts.md`](../../architecture/agent-accounts.md).
- [`version-compatibility.md`](../../architecture/version-compatibility.md#the-support-window) for older
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
