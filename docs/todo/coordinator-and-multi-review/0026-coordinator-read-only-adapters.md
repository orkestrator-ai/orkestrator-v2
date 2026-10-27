# Coordinator read-only adapters

Checked against `main` at `2459b05c` (2026-10-15). Every item worked through
on 2026-10-24 against `main` at `8454d18b`, on node mbp3 (macOS, arm64). What
is left needs a Windows host, a Linux host and live model runs; see
[Remaining work](#remaining-work).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Claude coordinator on Windows, live**: the read-only scenario on a Windows host, expecting `provider-configured` and hook-only refusals. Status: blocked (no Windows host; Windows builds are not in the release process).
2. **Claude coordinator on Linux, live**: the read-only scenario with a real model on Linux, with `bwrap`/`socat` present (`enforced`) and with either missing (`provider-configured`). Status: open (no longer blocked: this node is a Linux host with both installed).
3. **Live research-server call on Pi, Cursor and OpenCode**: one coordinator turn per platform that resolves React's Context7 library ID with the default research setting. Status: open.
4. **Re-check the tier decisions on pin bumps**: the conditions D4, D6, D8, D9 and the Windows-flag assumption say to revisit. Status: deferred (until the next Cursor, Grok, Codex or Claude bump).
5. **Close out the file**: what happens to the file once tasks 1 to 3 have evidence. Status: open.

### 1. Claude coordinator on Windows, live

**Problem.** A Windows Claude coordinator has never run with a real model. On Windows the hook allowlist is the whole read-only boundary, so a hole in it would be a real write to the user's checkout with no OS layer behind it (D1's con).

**Context.** Item 1 is code-complete. The tier comes from `defaultCoordinatorHostCapabilities`, which treats Windows as having no sandbox. `releasing.md` says Windows releases are not yet covered, so there is no shipped Windows build for users to hit this today.

**Investigation.** `apps/backend/src/core/coordinator-providers.ts:68` returns `{ claudeSandbox: false }` for any platform other than `darwin` and `linux`. `judge` (`:128`) then gives Claude `provider-configured` with the generic "needs macOS, or Linux…" reason. The launcher sets `ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX` from the same probe (`apps/backend/src/core/commands-servers.ts:876`) and clears an inherited one for workers (`:849`). The remaining-work text is slightly out of date. Since 0145, `unavailable` does more than set `failIfUnavailable: false`: it also turns the sandbox off entirely (`enabled: options.commandSandbox !== "unavailable"`, `bridges/claude-bridge/src/services/read-only-policy.ts:521`, and `:526` for `failIfUnavailable`). A Windows run therefore checks the hook alone, not "the sandbox requested without being required". `claudeSandboxRefusal` (`bridges/claude-bridge/src/services/claude-execution-sandbox.ts:74`) returns early on any platform but Linux, so it cannot refuse a Windows turn. Since this file was last updated, #1308 (`2c3147f6`) added inline skill plugins to Claude coordinators. It also added `managedSettings { allowManagedHooksOnly, disableSkillShellExecution }` (`bridges/claude-bridge/src/services/claude-query-config.ts:187`) to close skill-shell and plugin-hook paths the PreToolUse hook never saw. Those paths matter most on Windows, where nothing sits behind the hook, so a Windows run should include a project skill.

**Decisions.**

- **Keep this task open, or retire it until Windows ships?**
  - **Keep it blocked here until a Windows build exists (recommended).** Leave the item as is and run it when Windows enters the release process.
    - Pros: the evidence lands on the build users will actually run; avoids a one-off unpackaged Windows setup.
    - Cons: the hook-only boundary stays unproved live on Windows for as long as that takes.
  - **Run it now from a source checkout on a borrowed Windows host.**
    - Pros: evidence sooner, and it would surface any Windows bug in the hook or launcher early.
    - Cons: `mise run dev:test` and the live suite have never been qualified on Windows, so a failure may be in the harness rather than the boundary.
  - **Hide Claude as a coordinator on Windows until it is run.**
    - Pros: no unproved boundary is ever offered.
    - Cons: reverses D1 with no new evidence against it; Windows is not shipped anyway.
- **What counts as a pass?**
  - **The read-only scenario plus a project skill with inline shell and `allowed-tools` (recommended).** The standard scenario, plus a checkout skill that tries to write.
    - Pros: covers the bypass #1308 found, which has the most impact where the hook is the only layer.
    - Cons: the live suite has no such step yet, so it needs a manual step or a new test step.
  - **The read-only scenario only.**
    - Pros: no harness change; matches how macOS was qualified.
    - Cons: misses the skill path, which the 2026-10-24 macOS run also predates.

### 2. Claude coordinator on Linux, live

**Problem.** On Linux, Claude is `enforced` only when the bubblewrap probe passes, and no real-model coordinator run has confirmed either branch. A wrong `enforced` would tell the user the OS blocks writes when it does not.

**Context.** The offline `conformance-coordinator-sandbox-live.test.ts` passes on an Arch host (0145, 2026-10-26). CI removes Ubuntu's AppArmor profile, so CI says nothing about stock Ubuntu; that case is owned by [0145](../agent-engines/0145-claude-linux-sandbox-apparmor-nested-userns.md). The remaining-work item says it was "not run because this node has no Linux host". That was true of node mbp3.

**Investigation.** The current node is Linux (`7.2.8-9-omarchy`) with `/usr/bin/bwrap` and `/usr/bin/socat`: the same Arch/Omarchy host as 0145's offline evidence. So the `enforced` half is no longer blocked on hardware. The probe is `claudeLinuxSandboxStatus` (`packages/protocol/src/node/claude-linux-sandbox.ts:213`). The bridge re-runs it and refuses a turn that needs a sandbox it cannot start (`claude-execution-sandbox.ts:74`). The checkout write is denied through `filesystem.denyWrite` (`read-only-policy.ts:537`). The live task exists: `mise run test:agent:coordinator` (`mise.toml:271`) takes `--credential-source` and `--scenario` (`apps/desktop/scripts/test-agent-coordinator-live.ts:8`). Claude is on `COORDINATOR_LIVE_PLATFORMS` at `provider-configured` (`apps/desktop/scripts/dev/coordinator-live.ts:39`), so the suite does not itself assert that Claude came up `enforced`. The run has to read the tier from the picker or the summary. The "without" half needs `bwrap` or `socat` missing from the backend's `PATH`. The suite has no switch for that, so it means launching the profile with a reduced `PATH`.

**Decisions.**

- **Where to run it?**
  - **On this Linux node now, for both halves (recommended).** Run `mise run test:agent:coordinator --credential-source claude --scenario read-only` once normally and once with a backend `PATH` that hides `socat`.
    - Pros: unblocked today; the host already has offline evidence to compare against; it is cheap.
    - Cons: one distribution without AppArmor; stock Ubuntu stays with 0145.
  - **Wait and run it alongside 0145's Ubuntu, Debian and Fedora matrix.**
    - Pros: one batch covers every Linux variant.
    - Cons: delays a run that could happen now, and 0145's matrix needs hosts this node does not have.
- **How to produce the "without `bwrap`/`socat`" case?**
  - **Hide one program through the backend's `PATH` at profile start (recommended).**
    - Pros: exercises the real probe and launcher; nothing is uninstalled.
    - Cons: a manual step outside the suite, so it has to be written up carefully.
  - **Add a test-only override for the host capability.**
    - Pros: repeatable in the suite.
    - Cons: a new process-authority input on a security boundary, which the file's constraints argue against; it would also skip the real probe.
- **What counts as a pass for the `enforced` half?**
  - **Scenario passes, the picker shows `enforced`, and a probe write such as `uniq in out` is refused by the sandbox as well as the hook (recommended).**
    - Pros: shows both layers hold, which is what `enforced` claims.
    - Cons: the hook refuses `uniq in out` first since D3, so showing the sandbox layer needs the existing `claude-sandbox-write-probe.mjs`, not the scenario alone.
  - **Scenario passes.**
    - Pros: the same bar as macOS.
    - Cons: it cannot tell whether the sandbox or the hook did the refusing.

### 3. Live research-server call on Pi, Cursor and OpenCode

**Problem.** Research servers on these three platforms are covered only by unit tests (plus, for OpenCode, an offline run on the pinned binary). No real model has been seen choosing the tool. If the exact-id allowlists are wrong, the coordinator silently has no Context7.

**Context.** Item 10 (D10, D11, D12). Codex and Claude were shown live on 2026-10-16. The file says this belongs with 0024's per-platform runs.

**Investigation.** The adapters are still present: OpenCode `apps/backend/src/core/opencode-coordinator-research.ts` (with `-live`, `-registration` and unit tests); Cursor `hostResearchCustomTools` (`bridges/cursor-bridge/src/agent-session.ts:447`); Pi's `research` scope (`bridges/pi-bridge/src/mcp.ts:499`). The live suite cannot produce this evidence yet. `COORDINATOR_LIVE_SCENARIOS` is `read-only`, `async`, `family`, `status` and `peer` (`apps/desktop/scripts/dev/coordinator-live.ts:56`), and none of them asks for a research call. The read-only case switches research off on purpose (`settings: { coordinatorWebResearch: "off" }`, `e2e/agent-testing/coordinator-live.spec.ts:945`). Pins are unchanged since the work: Cursor SDK 1.0.40, OpenCode 1.19.4, Pi 1.4.0 (`docker/Dockerfile:195`, `:197`). #1308 also changed the Pi, Cursor and OpenCode coordinator boundaries (skill loading, plus an `orkestrator-skills__load` custom tool on Cursor), after the last read-only evidence.

**Decisions.**

- **Manual turns, or a new live scenario?**
  - **Add a `research` scenario to the live suite (recommended).** It runs with the default research setting, asks for React's Context7 library ID, and asserts that the tool call is attributed to the research server.
    - Pros: repeatable on every bump; covers all six platforms at once; fits the suite's per-platform summaries.
    - Cons: a code change to the harness; Grok has to be expected to fail or be skipped (it loads no research servers, item 8).
  - **Three manual coordinator turns, recorded in 0024.**
    - Pros: no code; quickest single proof.
    - Cons: not repeatable; a model can answer from memory without calling the tool, so the evidence has to come from the transcript row, not the answer.
- **Re-run the read-only scenario in the same batch?**
  - **Yes, on all six platforms, because #1308 changed every coordinator boundary after the 2026-10-24 runs (recommended).**
    - Pros: refreshes evidence that is now stale for the skill-loading paths; costs little extra once profiles are up.
    - Cons: more live provider spend, and Grok needs the `advisory` setting.
  - **No, research only.**
    - Pros: smaller run.
    - Cons: leaves the post-#1308 boundary unproved live on every platform.

### 4. Re-check the tier decisions on pin bumps

**Problem.** Several decisions rest on facts about one pinned version, and they need revisiting when that version moves: Cursor has no approval callback (D6), Grok's `open_page` survives without `--disable-web-search` (D8), the Codex lock has never tripped (D9), and Claude's Windows sandbox flag is off (Assumptions).

**Context.** The file lists these as "revisit when …" conditions, not as items. Moving a platform to `enforced` needs a test change in `coordinator-conformance.test.ts`, which pins `["claude", "codex", "pi"]` (`apps/backend/src/core/coordinator-conformance.test.ts:80`).

**Investigation.** Current pins: `@cursor/sdk` 1.0.40 (`bridges/cursor-bridge/package.json:15`), Grok 1.0.67 (`docker/Dockerfile:196`), Codex 0.164.0 (`:194`), Claude CLI 2.1.309 and SDK 0.3.309. Item 7 says "Verified against 0.162.1", but Codex was already 0.164.0 when the file was finished: the bump `28590e68` (2026-10-23) predates `95c9cb46` (2026-10-24). `bridges/codex-bridge/src/app-server/live-network-lock.test.ts` already describes 0.164.0 behaviour. `assertHostedNetworkLock` is at `bridges/codex-bridge/src/engine/app-server-engine.ts:1728`. Nothing here is outstanding today.

**Decisions.**

- **Where should these watch items live?**
  - **Add each to `docs/development/upgrade-agents.md` as a per-agent bump check, then drop it from this file (recommended).**
    - Pros: whoever bumps a pin sees it at the moment it matters; this file can then close.
    - Cons: one more step in the bump checklist; moving the items is a doc change outside this file.
  - **Leave them in this file's decisions.**
    - Pros: no doc move.
    - Cons: nobody bumping a pin reads this file, and it keeps the file from ever being Finished.

### 5. Close out the file

**Problem.** Every code item is done. Only live runs remain, and the file cannot be deleted until they are, even though its durable content (decisions D1 to D12, the Codex refused-cell rationale) belongs in `architecture/`.

**Context.** The README rules say to finish the items, set Finished to Yes, move durable behaviour into `architecture/` or `development/`, then delete the file. They also say never to add new todos to an existing file, so the remaining live runs cannot simply be moved into 0024.

**Investigation.** `docs/architecture/coordinator.md` already covers network and research and the qualification rules, and `AGENTS.md` covers the shell allowlist. The per-platform decision rationale (D1 to D12) and the refused-cell constraints are only here. The folder index rates the file Medium, rank 5, Finished: No, which still matches: qualification runs for secondary platforms only.

**Decisions.**

- **When to fold the durable content and delete the file?**
  - **When tasks 2 and 3 have evidence, move D1 to D12 and the refused-cell constraints into `coordinator.md` and the Codex bridge docs, then delete the file. Move task 1 into a new numbered file for Windows qualification (recommended).**
    - Pros: follows the README rules; the Windows blocker no longer holds the whole file open.
    - Cons: one more small todo file; the doc move has to be careful not to lose the options weighed.
  - **Keep the file until all three live runs, Windows included, are done.**
    - Pros: no split; one place for everything.
    - Cons: Windows has no date, so the file and its Medium row may stay open indefinitely.

Coordinator runs against the user's real checkout, so every platform it offers
must hold the same read-only outcome: creating a file, editing a file, running
a writing shell command and fetching a URL all fail, and Control MCP discovery
still works. The deny list is already one shared policy. What differs is how
strongly each adapter holds it, and the remaining work was a set of
per-platform decisions about that strength and the tier each platform
advertises.

## Current state

- The contract every qualified platform is held to (from the coordinator
  design). A finished coordinator conversation must:
  - **Inspect** the checkout under `coordinator-read-only`, with mutations
    denied by the adapter rather than by asking the model to behave. The
    per-platform strength differs; see the table below.
  - **Choose** platform and model on the first send, then stay on that
    binding. Done on every platform.
  - **Delegate** through Control MCP (`launch_environment`, `launch_job`,
    `send_message`, build and review) and finish the turn. Done on every
    platform; `delegation` is true for all six in
    `coordinator-conformance.test.ts`.
  - **Wake** exactly once per delegation when the worker's turn ends, with
    held progress mail delivered as one carrier, and a system notice for a
    silent worker. Done on every platform at the layer-test level; live
    evidence is in [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md).
  - **Queue** a prompt typed during a turn and run it before worker mail. Done
    on every platform.
  - **Steer** a running inspection turn where the platform has a steer
    adapter. Claude, Codex, Pi and Cursor do; OpenCode and Grok do not (see
    [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md)).
- The policy names operations, not vendor tools.
  `resolveNativeAgentExecutionPolicy(..., "coordinator")`
  (`apps/backend/src/core/native-agent-execution-policy.ts`) returns
  `capabilityPolicy.deny: ["file.write", "file.patch", "shell.mutate",
  "network"]`, `approvals: "deny"`, `projectResources: false` and
  `networkAccess: "restricted"`. `toolPolicy` stays Codex-shaped and is the
  user-override surface, so it cannot carry the translation.
- Process authority. `commands-servers.ts` sets
  `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only` on every
  coordinator bridge launch, and now also
  `ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX` (`required` or `unavailable`, from
  the same host probe the qualification table uses; workers never get it).
  Each bridge replaces whatever policy a request body or persisted record
  carries:
  - Claude: `bridges/claude-bridge/src/services/read-only-policy.ts`;
  - Codex: `isCoordinatorReadOnlyEnvironment` in
    `bridges/codex-bridge/src/codex-config.ts` (also honours the older
    `CODEX_BRIDGE_EXECUTION_POLICY`);
  - Cursor: `bridges/cursor-bridge/src/agent-session.ts`;
  - Pi: `BRIDGE_EXECUTION_POLICY_ENV` in `bridges/pi-bridge/src/agent-session.ts`;
  - Grok: `effectiveExecutionPolicy` in `bridges/acp-bridge/src/acp-policy.ts`,
    with `restorePersistedPolicy` (`acp-persistence.ts`) refusing a permissive
    persisted policy;
  - OpenCode has no bridge. The backend applies `effectiveOpenCodePolicy`,
    `openCodePermissionRules` and `openCodeCoordinatorAgent` (the `plan`
    agent) from `apps/backend/src/core/opencode-provider-helpers.ts`.
- Qualification is one table: `judge` and `coordinatorProviderQualification`
  in `apps/backend/src/core/coordinator-providers.ts`. Claude's tier depends on
  the host probe `defaultCoordinatorHostCapabilities`: always on macOS, never
  on Windows, and on Linux only when bubblewrap can nest the user namespace the
  CLI's seccomp helper needs, with `socat` on `PATH` (0145, 2026-10-26).
  **Settings → Agent platforms → Coordinator safety level** defaults to
  `provider-configured`. A platform whose tier is weaker than the setting is
  unavailable, and the tier's `reason` is shown in the picker.
- Per-platform strength today:

  | Platform | Tier | How read-only is held | Gap |
  | --- | --- | --- | --- |
  | Claude (macOS; Linux whose bubblewrap nests a user namespace, with `socat`) | `enforced` | SDK command sandbox with writes to the checkout denied (`filesystem.denyWrite`), `allowUnsandboxedCommands` off, `failIfUnavailable` on, an allowlist without writing tools, and a bridge `PreToolUse` hook that admits a fixed list of reading commands and refuses their writing arguments; WebFetch and WebSearch are off the allowlist, in `disallowedTools` and refused by the hook | Linux not yet run live on the probe's result |
  | Claude (Windows; Linux without `bwrap` or `socat`, or whose policy refuses the nested namespace) | `provider-configured` | Same, with the sandbox left off (0145); the hook allowlist is the boundary | No OS containment; not yet run live on Windows |
  | Codex | `enforced` | Permission profile that denies filesystem writes and network in the child; the bridge refuses a turn unless app-server echoes the profile back. Hosted web search (`web__run`) is switched off with `web_search = "disabled"`, and the bridge refuses a thread unless `config/read` reads it back | `sleep` is not denied (decided: not needed, item 2) |
  | Pi | `enforced` | In-process `tool_call` gate in the bridge; a name allowlist, so an extension's web tool is refused; research server tools admitted by exact registered name | None known |
  | OpenCode | `provider-configured` (final, item 3) | SDK `plan` agent plus permission rules (`*: deny`, a read-only list, the coordinator's own Orkestrator tools and research tools by exact id, then named denies for `webfetch`, `websearch` and `codesearch`) | Always loads the checkout's project configuration, including command-backed MCP servers in `opencode.json` |
  | Cursor | `provider-configured` (final, item 4) | SDK sandbox plus a built-in tool allowlist (`CURSOR_READ_ONLY_TOOLS`, with denied capabilities mapped by `CURSOR_CAPABILITY_TOOLS`), which leaves out `webFetch` and `webSearch`; a read-only session without a sandbox boundary is refused before attach | No approval callback in SDK 1.0.40, so a denial cannot be verified |
  | Grok | `advisory` | Write, edit, shell, built-in subagents and `monitor` removed with a private `--agent-profile`; web search, its `open_page` actions and web fetch removed with `--disable-web-search`; `--no-leader` keeps those restrictions local; remaining permission requests refused | A tool that does not ask is not stopped, including xAI's hosted X search tools, which no switch removes; not offered at the default safety level |

- Waiting tools. Claude refuses `Monitor`, `ScheduleWakeup`, the `Cron*`
  tools and `sleep`/`watch`/`timeout` (asserted in
  `coordinator-conformance.test.ts`). Grok's read-only profile removes
  `monitor` (read live on 1.0.67). OpenCode and Pi have no sleep primitive.
  Codex can run `sleep`; Cursor depends on the provider. The Control MCP poll
  guard (`coordinatorPollGuard` in `control-mcp-server.ts`) is the backstop.
- `coordinator-conformance.test.ts` pins the `enforced` set to exactly
  `claude`, `codex` and `pi`, so a platform cannot be promoted without a
  matching test change.

## Outstanding work

Every code item below is done or decided. The decisions, with the options
weighed, are in [Assumptions and decisions](#assumptions-and-decisions). What
still needs hardware or live runs this node cannot provide is under
[Remaining work](#remaining-work).

### Code

1. **Claude on Windows.** Done (D1, D2, D3). Claude stays offered at the
   default `provider-configured` level on hosts where its command sandbox
   cannot start, and never reports `enforced` there.
   - Found while deciding: the bridge always passed `failIfUnavailable: true`,
     and the pinned CLI (SDK 0.3.309) keeps its Windows sandbox behind a vendor
     feature flag that is off by default (`tengu_nankeen_kestrel`, read from
     the binary). So a Windows Claude coordinator was offered and then failed
     every turn. The launcher now tells the bridge the probe's answer
     (`ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX`); `unavailable` asks for the
     sandbox without requiring it, and `required` (or absent) keeps it
     required.
   - Linux had the same gap: the CLI refuses a required sandbox without
     `bwrap` or `socat`, but the probe reported `enforced` on any Linux.
     `defaultCoordinatorHostCapabilities` now checks both on `PATH`
     (`coordinator-providers.test.ts`).
   - Found while testing on macOS: the SDK sandbox lets a command write its
     working directory. Live on this Mac, a coordinator turn with the
     bridge's own options ran `uniq in.txt out.txt` (admitted by the hook) and
     wrote `out.txt` into the checkout of an `enforced` Claude coordinator
     (`scripts/coordinator-probes/claude-sandbox-write-probe.mjs`). The
     coordinator sandbox now denies writes to the checkout
     (`filesystem.denyWrite`, the path and its real path); the same probe
     then got "Operation not permitted". Regression test against the pinned
     CLI with a scripted local model:
     `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts`
     (fails with the denial removed).
   - Because the hook is the whole boundary where the sandbox cannot start,
     it was hardened (`isReadOnlyShellCommand`, `read-only-policy.test.ts`):
     positional outputs (`uniq`, `xxd`, `hostname`), clustered and attached
     one-letter flags (`sort -no out`, `-oout`), more writing flags (`sort -T`
     and `--compress-program`, `file -C`, `yq -s`), an option allowlist for
     awk (gawk's `-i inplace`, `-o`, `-p`, `-f`, `-E`, `-l`), git output and
     program options (`--output`, `--ext-diff`, `--textconv`, `--filters`,
     `--config-env`, `--exec-path`, `grep -O`), path-qualified programs
     (`bin/cat`), and the network-only `gh`, `curl`, `wget`, `git ls-remote`,
     `git fetch` and `git pull`.
   - Live on macOS after the change (2026-10-24, node mbp3, rebuilt
     `claude-bridge/dist`): the probe's `uniq in.txt out.txt` was refused by
     the hook and wrote nothing, and
     `mise run test:agent:coordinator --credential-source claude --scenario read-only`
     passed (every mutation refused, checkout digest unchanged, discovery
     returned; run `qa-coordinator-2026-10-24T00-36-14-146Z`).
2. **Codex `sleep`.** Decided: no argv0 deny (D4). Live evidence on
   2026-10-18: no Codex coordinator ran `sleep` in the async and worker-mail
   family scenarios (nor did Claude, OpenCode or Cursor), and the poll guard
   covers mailbox polling. Revisit only if a live run in
   [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
   shows Codex reaching for it.
3. **OpenCode at `enforced`.** Decided: OpenCode stays `provider-configured`
   as its final tier (D5). Unification does not require `enforced`, and
   disabling project MCP servers would not make it `enforced`: OpenCode has no
   OS sandbox, so its permission engine stays the boundary. The note from
   `effectiveOpenCodePolicy` stays on its qualification `reason`.
4. **Cursor.** Decided: stays `provider-configured` as its final tier (D6).
   Checked the pinned `@cursor/sdk` 1.0.40: still no approval callback
   (`LocalAgentOptions` has `sandboxOptions`, `autoReview` and `customTools`,
   whose calls bypass approval by design), so a denial still cannot be
   verified.
5. **Grok.** Decided: stays `advisory` (D7). The profile now also removes
   `monitor` (item 8 evidence). A live qualification remains in
   [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md),
   where Grok has not run yet; it would not by itself change the tier, because
   unasked tools outside the removed set (the hosted X search tools) still
   have no boundary.
6. **Pi.** No change to its boundary. It gained research servers (item 10).
7. **Hosted network tools and web research.** Done. A live run of the
   read-only suite found a Codex coordinator reaching `https://example.com`
   through Codex's hosted web search while its permission profile had the
   network off: the profile stops commands, and hosted search runs on OpenAI's
   servers. Every policy whose `capabilityPolicy` denies `network` now loses
   the provider's hosted and network tools, except that
   `capabilityPolicy.allow: ["web.search"]` keeps hosted search. The
   coordinator gets that exception from **Settings → Agent platforms →
   Coordinator web research** (default: search plus research servers), passed
   to each bridge at launch as process authority. Hosted page fetch has no
   exception in any mode. See
   [`coordinator.md`](../../architecture/coordinator.md#network-and-web-research).
   - Codex: `web_search = "disabled"`, or `"cached"` when search is allowed,
     never `live`; `features.standalone_web_search = false`. The engine reads
     the expected mode back through `config/read` once per app-server
     generation and refuses the thread on any other value
     (`assertHostedNetworkLock`). Research servers are `-c mcp_servers.*`
     overrides with approved tools. Verified against 0.162.1:
     - The loopback `live-network-lock.test.ts` reads the tools from the real
       model request.
     - Its canary showed `live` open a fresh Wikipedia search page while
       `cached` refused it ("Cache miss"), and a coordinator call Context7 from
       inside its permission profile.
     - A `dev:test` profile with real credentials, before the research setting
       existed: the old bridge searched and returned example.com's title; the
       fixed bridge said "Web search is not available to me", and its `curl`
       could not resolve a host.
     - The same on 2026-10-16 with the default setting, for a Codex main and a
       Claude side coordinator. Both found Bun's latest version through web
       search and React's Context7 library ID through Context7. Neither could
       open a fresh Wikipedia search page: Codex got "Cache miss", and Claude
       found no tool that opens a URL. Claude's attempt to write a plan file
       was refused.
   - Claude: WebSearch on the allowlist when allowed; WebFetch denied by name
     and by the hook; research servers added to the inline MCP set and
     allowed by name. Any other network-denied policy gets the same tools in
     `disallowedTools` (`claudeDisallowedTools`).
   - OpenCode: `webfetch` denied after every allow (a `task` subagent inherits
     it); `websearch` and `codesearch` allowed by name when search is allowed,
     else denied.
   - Cursor: `webSearch` joins the read-only allowlist when allowed; `webFetch`
     never does.
   - Grok: `--disable-web-search` and `--no-leader`, keyed by provider id and
     applied to policy-less children in a coordinator process. Search stays
     off on Grok (item 8).
   - Pi: no hosted tools; its name allowlist refuses an extension's web tool.
   - The coordinator context now says what research is available, to keep its
     own work to quick looks and delegate anything serious, and to report a
     tool as refused only after a call was refused.
8. **Grok search without fetch.** Done: not possible on the pinned build, so
   Grok coordinators keep search off (D8). Read live on Grok 1.0.67 (the pin)
   over ACP with the bridge's read-only profile, `--no-leader` and no
   `--always-approve`, using
   `scripts/coordinator-probes/grok-web-tools-probe.mjs` on 2026-10-24:
   - 1.0.67 has no `GROK_DISABLE_WEB_FETCH`. It documents `GROK_WEB_FETCH`
     (`0`/`1`) and `features.web_fetch`. `GROK_WEB_FETCH=0`, or `web_fetch`
     in the profile, each removes the client `web_fetch` tool on its own
     (variants `env-only` and `profile-only`).
   - With search left on, the hosted `web_search` also offers `open_page` and
     `open_page_with_find`. Asked to open `https://example.com` with no fetch
     tool, the agent did it through a search call and answered "Example
     Domain". Neither the profile's `disallowedTools` nor the top-level
     `--disallowed-tools` removes those actions.
   - `--disable-web-search` removes `web_search`, `open_page`,
     `open_page_with_find` and `web_fetch`: the agent answered NO-FETCH and
     NO-SEARCH and made no call.
   - xAI's hosted X search tools (`x_keyword_search`, `x_semantic_search`,
     `x_user_search`, `x_thread_fetch`) survive every switch tried. They are
     named in Grok's qualification `reason` and policy `note`.
   - The profile can remove `monitor`, Grok's waiting tool, and now does.
9. **Readiness for a failed Codex lock.** Decided: not added (D9). No Codex
   bump has tripped `assertHostedNetworkLock`, and a new
   `NativeAgentReadiness` state reaches the protocol, the renderer and every
   provider. Add one if a bump ever does; the failed first turn already names
   the cause.
10. **Research servers on OpenCode, Cursor and Pi.** Done (D10, D11, D12).
    - OpenCode: `opencode-coordinator-research.ts` registers each server on
      the coordinator's own `opencode serve` at launch (`POST /mcp`, which
      replaces a project entry under the same name) before the conversation
      is ready. OpenCode 1.19.4 lists no MCP tools over HTTP (read on the
      pinned binary: `/experimental/tool/ids` and `/experimental/tool` return
      built-ins only), so the backend lists each server's tools itself and
      allows exactly `<name>_<tool>` in the coordinator's permission rules.
      It leaves out an id that a project server named `<name>_…` could also
      produce. Offline test on the pinned binary with a project
      `context7_x` server and a command-backed `context7` entry:
      `opencode-coordinator-research-live.test.ts`; rules and attribution:
      `opencode-coordinator-research.test.ts`,
      `coordinator-conformance.test.ts`.
    - Cursor: `hostResearchCustomTools` hosts each server's tools in-process as
      `<name>__<tool>` custom tools beside Orkestrator's (a sandboxed
      read-only attach cannot call an HTTP MCP server). Calls and inventory are
      published under the research server's own name, scoped as
      Orkestrator-configured (`mcp.test.ts`, `agent-session.test.ts`,
      `tool-rendering.test.ts`).
    - Pi: research servers resolve in a coordinator process only, as a
      `research` scope reserved like `orkestrator` (a `mcp.json` entry of the
      same name is dropped), and the read-only gate admits their tools by exact
      registered name (`interactions-gate.test.ts`,
      `coordinator-conformance.test.ts`).
    - Grok loads none (item 8).
11. **Show Codex sandbox refusals in the live transcript.** Done. Under a
    `read-only` or `workspace-write` sandbox, Codex 0.162.1 emits no item for
    a rejected `apply_patch`, nor for a failing command whose output looks
    like a sandbox denial ("Operation not permitted", "Permission denied",
    "Read-only file system", "sandbox", "landlock", "seccomp", "failed to
    write file"). This was mapped on the pinned binary; full access itemizes
    everything. The model is told and usually says the call was denied, so a
    Codex coordinator, reviewer or sandboxed session looked as if it claimed a
    denial it never tried. `RefusedCellTail` (`bridges/codex-bridge/src/sessions/refused-cell-tail.ts`)
    now reads the active turn's records from the rollout app-server names in
    `thread.path`, and shows a code-mode cell as a failed `exec` row in two
    cases: no item of the turn started while it ran, or its output carries a
    refusal. It reads from the rollout size captured before `turn/start`,
    every 200 ms, and before each new model response and the turn's
    completion are applied. See "Constraints and rationale" for the choices.

### Qualification

- The live read-only scenario (tree hash unchanged, every mutation denied,
  discovery still returns) runs per platform in
  [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md).
  The decisions above no longer wait on it. It is still where a Grok run,
  a research-server call per platform and the hardened Claude allowlist get
  their live evidence.

### Remaining work

What is left of items 1 and 10. These need hardware, an OS or live model
runs that node mbp3 could not provide. Everything that could be done here (code, tests, probes and the
decisions) is done.

- [ ] **Claude coordinator on Windows, live (rest of item 1).** Run the live read-only scenario
  (`mise run test:agent:coordinator --credential-source claude`, see
  [`agent-testing.md`](../../development/agent-testing.md)) on a Windows host.
  Expect the picker to show Claude as `provider-configured` with the
  "command sandbox is unavailable" reason, the bridge to start turns
  (`failIfUnavailable: false` from `ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX=unavailable`)
  rather than fail them, and every mutation to be refused by the hook.
  Not run because this node is macOS only. Windows Orkestrator builds are
  also not covered by the release process yet
  ([`releasing.md`](../../development/releasing.md)).
- [ ] **Claude coordinator on Linux, live, with and without `bwrap`/`socat` (rest of item 1).**
  The same scenario on a Linux host with both installed (expect `enforced`,
  and the checkout write refused with `denyWrite` under bubblewrap) and with
  either removed from `PATH` (expect `provider-configured` and turns that
  run). The offline `conformance-coordinator-sandbox-live.test.ts` covers the
  first case on any Linux CI host with bubblewrap. Not run because this node
  has no Linux host.
  CI evidence (2026-10-25, todo 0030): on GitHub's Ubuntu 26.04 runner the
  test's positive cases failed on every run, because Ubuntu's
  `bwrap-userns-restrict` AppArmor profile stops the CLI's nested user
  namespace, so every sandboxed command fails while the host still reports
  `enforced`. CI now removes that profile; a stock Ubuntu host is still
  affected, which is tracked in
  [0145](../agent-engines/0145-claude-linux-sandbox-apparmor-nested-userns.md).
  Offline evidence (2026-10-26, 0145): on an Arch/Omarchy host (kernel 7.2.8,
  bubblewrap 0.13.1, no AppArmor) the probe reports the sandbox available in
  about 5 ms, Claude qualifies as `enforced`, and all 9 cases of
  `conformance-coordinator-sandbox-live.test.ts` pass with the pinned CLI
  2.1.309, including the new `unavailable-hook-reads`. A live coordinator run
  with a real model on Linux is still owed.
- [ ] **A research server call on Pi, Cursor and OpenCode, live (rest of item 10).** One
  coordinator turn per platform with the default research setting that
  resolves React's Context7 library ID, as was done for Codex and Claude on
  2026-10-16. The adapters are covered by unit tests and, for OpenCode, an
  offline run on the pinned binary; none has been seen with a real model
  choosing the tool. Belongs with the per-platform runs in
  [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md).

## Constraints and rationale

- Refused Codex calls are read from the rollout, not from app-server's raw
  events. `experimentalRawEvents` streams the cell as
  `rawResponseItem/completed` (checked on 0.162.1), but only `thread/start`
  accepts it. A thread resumed in a new app-server process never gets raw
  events, with or without the flag, and neither does a fork. Every session and
  coordinator conversation that outlives an app restart would lose the rows
  again. Raw events would also have needed `experimentalApi` for the whole
  connection. The rollout covers started, resumed and reloaded threads alike.
- The tail polls every 200 ms while a turn runs. `fs.watch` fired nothing on
  macOS for Codex's appends (same inode, growing size). The poll alone can
  still lose a race with a fast next response, so while a tail is active the
  turn's events are applied in order: an event that opens a new model
  response, and `turn.completed`, wait for a rollout read, and cells that
  finished before it are placed first. Only this thread waits; app-server's
  notification stream keeps being consumed. The queue is bounded; on overflow
  the bridge stops reading the rollout, applies every queued event and tells
  readers to reconcile. A poll with nothing new costs one `stat`.
- The tail starts at the rollout size captured before `turn/start` is sent,
  not at the end of the file when `turn/started` is applied: a fast turn can
  write its cells before that. A turn that did not go through the prompt path
  (an inline review) reads a bounded window and keeps only records carrying
  its own turn id.
- A cell becomes a row in two cases: no client tool item of the turn started
  while it ran, or its output carries "patch rejected", "Operation not
  permitted", "Permission denied" or "Read-only file system". Codex's own
  heuristic also suppresses on "sandbox", "landlock", "seccomp" and "failed to
  write file", but ordinary output says those words (this repository's files
  do), and a cell whose calls already have rows would gain a duplicate. The
  no-item rule still shows such a cell when nothing else does. Showing every
  cell, as a reload does, was rejected for the same reason: each nested
  command would appear twice in the live view.
- The row is a completed `dynamic_tool_call` named `exec`, failed when the
  output reports a refusal or a failed script. That is the row a reload
  builds from the same rollout record, with the same id (the `call_id`).
- Only code-mode cells are read. Every model Codex 0.162.1 serves runs in
  code mode. A direct `apply_patch` or `exec_command` call from a model that
  does not would still be missing, as before.

- Do not cover a missing adapter half with prompt text. A platform joins the
  unified set only when its adapter holds the same contract as the others.
- Moving a platform to `enforced` claims that the provider or the OS blocks
  the mutation whatever the agent attempts. It needs all of:
  - a translation of `capabilityPolicy` into the provider's own vocabulary, in
    the bridge, applied on create, resume, config and every turn;
  - `ORKESTRATOR_BRIDGE_EXECUTION_POLICY` honoured as process authority;
  - an entry in the `enforced` list in `coordinator-conformance.test.ts`;
  - a place in the live suite's platform list (see
    [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)).
- New adapter work must honour the policy on create, resume, config and every
  turn, and fail closed if a persisted session carries another policy id.
- Where a platform cannot honour an axis, report it in the policy's `note` and
  leave the tier at `provider-configured`. Do not silently drop the axis.
- Do not reintroduce a platform literal at any qualification gate (workspace
  service, runtime resolver, bridge launcher, trusted session input). That is
  what once let a platform hold a conversation but be refused a bridge.
- `delegation` is derived (`mcpClient && canInject`), not declared. The tier is
  about sandbox strength, not mail.
- An OS sandbox is not a write guard for the checkout unless it is told so.
  The Claude SDK sandbox's default write allowance includes the working
  directory. Any sandbox a coordinator relies on must deny the checkout
  explicitly, and the command filter must not assume a sandbox behind it.

## Assumptions and decisions

Each decision lists the options considered, the choice, why, and its pros and
cons.

**D1. Is Claude offered on Windows at the default safety level?**

- Options: (a) keep it at `provider-configured` with the hook allowlist as the
  boundary; (b) drop it to `advisory`, off by default; (c) mark it
  unavailable on Windows.
- Chosen: (a).
- Why: the hook is a bridge-owned allowlist of reading commands with a closed
  tool allowlist and `canUseTool` refusing the rest. That is the same kind of
  boundary as OpenCode's permission engine, which is `provider-configured`.
  `advisory` means only the agent's cooperation holds the boundary, which is
  not the case here.
- Pros: Windows users keep a coordinator. The tier and reason say plainly that
  nothing outside the agent enforces it, and an `enforced`-only installation
  refuses it.
- Cons: a bypass of the command filter on Windows is a real write, with no OS
  layer behind it. D3 narrows that; the live Windows run is still owed.

**D2. How does the bridge learn whether the sandbox can start?**

- Options: (a) the backend's probe, passed at launch as process authority
  (`ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX`); (b) a second probe in the
  bridge; (c) always `failIfUnavailable: false`.
- Chosen: (a), absent or malformed reading as `required`.
- Why: one probe decides both the tier the user sees and what the bridge
  requires, so they cannot disagree. Process authority matches how the
  execution policy and the research setting already reach bridges, and a
  request body cannot change it.
- Pros: fail-closed by default; an older launcher keeps the sandbox required;
  workers never receive the variable (the launcher clears an inherited one).
- Cons: the probe is a necessary condition only. A Linux host with `bwrap`
  but no user namespaces still reports `enforced`, and there the required
  sandbox fails the turn rather than running unsandboxed. That failure is
  safe but visible. (Superseded 2026-10-26 by 0145: the probe now runs
  bubblewrap with a nested user namespace, and `unavailable` leaves the
  sandbox off.)

**D3. Deny the checkout in the sandbox, and harden the command filter.**

- Options: (a) `filesystem.denyWrite` on the checkout plus a hardened hook;
  (b) only the hook; (c) only the sandbox setting.
- Chosen: (a).
- Why: the sandbox write was a live, reproducible write through an `enforced`
  coordinator. Denying the checkout closes it whatever the hook admits. The
  hook is the whole boundary where no sandbox starts, so it also has to refuse
  every writing form it can recognise.
- Pros: two independent layers on macOS and Linux; the filter no longer relies
  on a sandbox it may not have. The refusals of network-only commands cost
  nothing, because sandboxed coordinator commands have no network anyway.
- Cons: a stricter filter refuses some reading forms: `/usr/bin/cat` (use
  `cat`), `gh` entirely, clusters such as `date -Iseconds` or `yq -ojson`
  that contain a refused letter, and awk options other than `-F` and `-v`.
  The refusal says why, and the work can be delegated.

**D4. Codex `sleep`.**

- Options: (a) argv0 deny for `sleep` and similar in the permission profile;
  (b) no deny, poll guard as the backstop.
- Chosen: (b), as the item itself required live evidence first.
- Why: no Codex coordinator ran `sleep` in the 2026-10-18 live runs, and
  mailbox polling is already refused by the Control MCP poll guard.
- Pros: no new profile surface to keep in step with Codex bumps.
- Cons: a Codex coordinator that does choose to sleep wastes a turn's time
  until the live suite catches it.

**D5. OpenCode's final tier.**

- Options: (a) `provider-configured` as final; (b) work towards `enforced` by
  disabling project MCP servers (for example `OPENCODE_DISABLE_PROJECT_CONFIG`
  for coordinator servers).
- Chosen: (a).
- Why: `enforced` claims the provider or the OS blocks a mutation whatever the
  agent does. OpenCode has no OS sandbox; its permission engine would remain
  the boundary even with project servers gone. Disabling project config could
  also drop providers or models a user configured per project.
- Pros: the tier tells the truth; nothing a user relies on changes.
- Cons: command-backed project MCP servers still start with a coordinator's
  OpenCode server, as they would in any OpenCode session on that checkout.

**D6. Cursor's final tier.**

- Options: (a) `provider-configured` as final; (b) wait for a verification
  probe before deciding.
- Chosen: (a); SDK 1.0.40 checked, still no approval callback.
- Why: same answer as the open question: "same product" means the same
  outcomes with the strength shown honestly, not the same tier. The sandbox
  plus a closed tool allowlist is real configuration; it just cannot be
  verified from outside.
- Pros: no indefinite open item; the tier and reason already say what is
  missing.
- Cons: re-open if Cursor ships an approval or tool-call callback.

**D7. Grok's tier.**

- Options: (a) stay `advisory`; (b) move to `provider-configured` now that
  the profile removes the mutation tools.
- Chosen: (a).
- Why: the hosted X search tools survive every switch, and tools that never
  ask are still not stopped. That is the definition of `advisory`.
- Pros: Grok stays opt-in at the default level, as before.
- Cons: Grok users who want a coordinator must lower the safety level.

**D8. Grok search when research is on.**

- Options: (a) keep `--disable-web-search` (search off); (b) drop the flag and
  remove fetch alone with `GROK_WEB_FETCH=0` and a profile entry.
- Chosen: (a).
- Why: live on 1.0.67, (b) still opened `https://example.com` through the
  hosted search's `open_page`, which neither the profile nor
  `--disallowed-tools` removes. A coordinator never gets page fetch.
- Pros: the research setting's "never fetch" holds on Grok.
- Cons: Grok coordinators get no web search at all. Re-check on a Grok bump
  with the probe script.

**D9. Readiness state for a failed Codex lock.**

- Options: (a) add a `NativeAgentReadiness` state now; (b) leave it until a
  Codex bump trips the check.
- Chosen: (b), as the item proposed.
- Why: the check has never tripped, and the state would touch the protocol,
  the renderer and every provider for a case that has not happened.
- Pros: no speculative protocol change.
- Cons: if a bump does trip it, the user sees a failed first turn rather than
  a not-ready conversation.

**D10. How OpenCode allows research tools.**

- Options: (a) a `<name>_*` permission pattern; (b) exact ids from OpenCode's
  own tool listing; (c) exact ids built from the research server's own tool
  list, minus ids a longer-named project server could share.
- Chosen: (c).
- Why: OpenCode always loads the checkout's configuration, so a project server
  named `<name>_x` would fall under (a). (b) is not possible: OpenCode 1.19.4
  lists only built-in tools over HTTP (read on the pinned binary). The
  existing coordinator rules already allow Orkestrator's tools by exact name
  for the same reason.
- Pros: no pattern a checkout can grow into; registration replaces a project
  entry under the research name; failures leave the coordinator without that
  server rather than failing the launch.
- Cons: the backend contacts each research server once at launch to list its
  tools. A tool the server adds later is not allowed until the next launch.
  An OpenCode instance reload drops the runtime registration, and a backend
  that restarts beside a still-running OpenCode server has no ids recorded, so
  research tools stay denied until the conversation's agent restarts.

**D11. How Cursor hosts research tools.**

- Options: (a) inline HTTP `mcpServers`; (b) in-process custom tools.
- Chosen: (b).
- Why: Cursor's SDK fails HTTP MCP calls closed on a sandboxed,
  approvals-deny attach, which is why Orkestrator's own tools are hosted the
  same way.
- Pros: works inside the coordinator sandbox; the bridge owns the connection
  and its bounds.
- Cons: tool names carry a `<name>__` prefix inside the SDK's
  `custom-user-tools` carrier, which the bridge unwraps for rows and inventory.

**D12. Pi research servers and name collisions.**

- Options: (a) research servers reserved, dropping a `mcp.json` entry of the
  same name; (b) let the user's entry win.
- Chosen: (a), and only under the coordinator's process authority.
- Why: the read-only gate admits research tools by registered name; a user
  entry under that name is usually a local program, which a coordinator must
  not run as if it were the remote server.
- Pros: the gate's exemption means exactly the launcher's servers.
- Cons: a user's own same-named server is unavailable to coordinators (it
  still works in ordinary Pi sessions).

Assumptions:

- The pinned Claude CLI's Windows sandbox stays off by default. If the vendor
  flag turns on, `unavailable` already asks for the sandbox, so Windows gains
  it without a change, though it is still reported as `provider-configured`.
- OpenCode names an MCP tool `<server>_<tool>` with other characters than
  letters, digits, `_` and `-` replaced by `_`, and checks its permission by
  that id. The coordinator's Orkestrator tool rules already rely on this.
- Research servers listed in settings answer an unauthenticated MCP
  `tools/list`, as Context7 does; one that does not is skipped.

## Open questions

None open. The two that were here are answered by D1 (Windows Claude stays at
the default level, as `provider-configured`) and D5 and D6 (`provider-configured`
is the final tier for OpenCode and Cursor).

## Related

- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md): the live
  suite that produces the evidence these decisions need.
- [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md): the
  smaller parity gaps (all closed); steer is in
  [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md).
- [`coordinator.md`](../../architecture/coordinator.md): "Provider qualification"
  and "Changing qualification"; `AGENTS.md` "Coordinator qualification" and
  "Coordinator shell allowlist".
- [`control-mcp.md`](../../architecture/control-mcp.md) ("Project coordinator
  credentials").
- Probes: `scripts/coordinator-probes/claude-sandbox-write-probe.mjs` and
  `scripts/coordinator-probes/grok-web-tools-probe.mjs`.
- Living-doc drift: done. `coordinator.md` no longer links
  `docs/todo/coordinator-to-implement.md`; its introduction points at this
  file, 0024 and 0028, and "Tests that exist today" points at 0024.

## Replaces

- `docs/todo/coordinator-to-implement.md` (introduction, "The unified
  interface", the read-only and waiting-tool rows of "Current matrix", and §1
  "Read-only adapters")
