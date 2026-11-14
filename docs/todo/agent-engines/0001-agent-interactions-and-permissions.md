# Agent interactions and permissions

Checked against `main` at `2459b05c` (2026-10-15); items 2, 4 and 6 and the
capability half of item 13 updated on `b83ae534` (2026-10-22). Every code
item, the open questions and the verification items worked through on
`00a0cb82` (2026-10-25); what is left needs a live provider or a person.

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da89` for tasks 2 and 7, and
against `main` at `c1724ab7` for task 9's macOS half; 2026-11-10 against
`main` at `c98b20e6f` for task 9's Linux half; task 3 built 2026-11-13
against `main` at `17d28238c`; the other tasks as analysed 2026-10-27
against `main` at `863b5782`.

Code items 1 to 5, 7, 8, 10, 11 and 13 are done on `main` and are not
repeated as tasks; their live checks are. The open questions and the
"Needs verification" items are all answered.

### Tasks

1. **Grok project resources off**: Grok loads a trusted checkout's resources whatever the policy says (item 12); re-probe on every Grok bump and honour the switch once xAI adds one. Status: blocked (on xAI: no "never trust" switch in Grok 1.0.67). The upstream request is drafted in [`docs/upstream-issues/grok-never-trust-switch.md`](../../upstream-issues/grok-never-trust-switch.md) (2026-11-14: upstream reports are not to-dos); the user files it.
2. **Codex project-resources residual risks**: the three risks left open under item 6. Status: done (the hook canary is added, the slash-catalogue risk was already closed, and a skill written during a running turn is kept as residual risk).
3. **Live Grok pause and approval kinds**: make the `grok-approval` case of the paused-interactions spec assert `command-approval` rather than the generic approval set, so the live run proves item 2's mapping. Status: done (2026-11-13; see "Task 3: assert the kind after finding the card"). The live Grok runs themselves (they need a valid Grok login) moved to 7568 on 2026-11-10.
7. **Browser interaction checks**: MCP elicitation rehydration, Claude `ask` and `deny` overrides, a coordinator turn that delegates and asks. Status: done with provider fakes (`e2e/InteractionPolicyChecks.spec.ts`); a coordinator turn on a real model went to 0024 and then 6940 (both retired 2026-11-13): the live suite's `ask` scenario, whose billed runs are on the manual-test checklist.
8. **Container cells on Cursor and Pi**: `mise run test:agent:docker` for Cursor and Pi. Status: done (2026-11-06, fake engines; the opt-in real-provider variants are `e2e/agent-testing/container-real-engines-live.spec.ts`, from 7040 (retired), and their signed-in runs are in [7568](../manual-test/7568-manual-test-checklist.md)).
9. **Claude provider sandbox on a real CLI**: `allowUnsandboxedCommands: false` and `strictAllowlist` hold. Status: done (macOS half 2026-11-06, Linux bubblewrap half 2026-11-10, both with `mise run verify:claude:sandbox-live`; no sandbox defect found; Linux's direct-loopback difference is documented, and since 2026-11-11 Agent Info carries a note for it (7563 (retired))).

### 1. Grok project resources off

**Problem.** With project resources off (the host default), Grok still loads AGENTS.md, skills, commands, hooks and MCP servers from a checkout whose main repository the user trusted in Grok, including a fresh `git worktree` of it. That crosses the execution-policy boundary on the host.

**Context.** Codex was closed the same way in item 6. Decision 14 rejected a throwaway `GROK_HOME`. `acpReportedPolicy` reports the axis honestly as on, with a note.

**Investigation.** Unchanged. Grok is pinned at `1.0.67` (`packages/toolchain/src/manifest.ts:9`). The bridge only opens the gate: `PROJECT_TRUST.grok.env = { GROK_FOLDER_TRUST: "0" }` when the policy enables project resources (`bridges/acp-bridge/src/acp-provider-config.ts:115-143`); `acp-policy.ts:73-75` reports `projectResources: true` otherwise.

**Decisions.**

- **Wait for xAI or ship the throwaway-home workaround?**
  - **Wait for an xAI switch and re-probe on every Grok bump with `_x.ai/hooks/list` (recommended).**
    - Pros: keeps the user's config, skills, MCP servers and `session/load` store; the probe needs no model turn, so it is cheap to repeat.
    - Cons: the leak persists on hosts where a main checkout was trusted.
  - **Qualify a throwaway `GROK_HOME` with `GROK_AUTH_PATH` pointing at the real login, resume included, and ship it for policy-off sessions.**
    - Pros: closes the leak now.
    - Cons: loses user-level config and skills; resume depends on a session store in the throwaway home; the very qualification decision 14 found too costly.
- **Ask xAI?** Filing is an outward action; the report is drafted in [`docs/upstream-issues/grok-never-trust-switch.md`](../../upstream-issues/grok-never-trust-switch.md) (Status `draft` until its "Before filing" checks pass), and filing it once it is marked ready is the manual-test checklist's "File the upstream reports" item.
  - **File an upstream request for a per-process "never trust" switch (recommended).**
    - Pros: the only clean fix; small for xAI.
    - Cons: no control over timing.
  - **Do not.**
    - Pros: no effort.
    - Cons: the item may stay blocked indefinitely.

### 2. Codex project-resources residual risks

**Problem.** Item 6 left three risks: a repo skill added while a thread is loaded is not disabled until the thread restarts, the slash catalogue listed repo skills for a policy-off session, and hooks were not probed on their own.

**Context.** Item 6's pin covers config layers, AGENTS.md and MCP; skills need a thread-scoped `skills.config`.

**Investigation.** The catalogue risk is closed: `skillUnavailability` (`bridges/codex-bridge/src/commands/skill-inventory.ts:204-213`) marks every non-user/system/admin skill "disabled because project resources are off for this session", and both catalogue rows and typed dispatch go through it (`bridges/codex-bridge/src/commands/codex-command-catalogue.ts:274,421,444-467,514`), so the bridge refuses the dispatch itself. This landed in #1147 (`649482d8`, 2026-10-22), so item 6's text is out of date on this point.

The mid-thread skill gap is mostly closed by the same change. `skills/changed` bumps `projectSkillsRevision` (`app-server-runtime-lifecycle.ts:771-776`), and the next prompt on a thread whose revision is older re-reads `skills/list` with `forceReload` and resumes the thread with the new exclusions before `turn/start`, or refuses with 503 when the inventory keeps changing (`app-server-runtime-prompt.ts:431-511`). The unit test "skills changed refreshes exclusions before the next attached turn" (`app-server-runtime-prompt.test.ts`) and the live case "new repository skills are excluded after a skills change and reload" cover it. What is left is a skill written into the checkout while a turn is running, which can reach only the rest of that turn.

Hooks are now probed on their own (2026-11-06). Codex 0.166.0 reads project hooks from `.codex/hooks.json` and from `[hooks]` in `.codex/config.toml`, and runs a non-managed hook only when the user config records its hash (`[hooks.state."<key>"] trusted_hash`), which `hooks/list` reports as `trustStatus`. `live-project-trust.test.ts` now declares `SessionStart` and `UserPromptSubmit` command hooks that write marker files, and its fixture trusts them by hash through `hooks/list`, so only the pin can stop them. Against the pinned 0.166.0 (three runs, 4 of 4 passing each) the control sees both hooks run; the pinned, reloaded and linked-worktree cases see none.

Running the file first showed it was stale on main: its three pinned cases failed because the AGENTS.md canary reached the model. That copy is the bridge's own `repositoryInstructionsBlock`, which `AppServerEngine.developerInstructions` adds on purpose when the pin drops Codex's native load (agent-engines.md, "The repository's AGENTS.md"). The test now counts only copies past the bridge's, and asserts the bridge's copy arrives exactly once. `upgrade-agents.md` did not list the file among the Codex bump gates, which is how this went unnoticed; it does now.

**Decisions.**

- **How to close the mid-thread skill gap?**
  - **Accept the within-turn remainder as residual risk; the turn-boundary half is closed by the `skills/changed` reload (recommended, chosen).**
    - Pros: the only remaining path is the model invoking a repo skill written into the checkout during the same turn, which needs the turn itself (or a process it started) to write it; the next turn drops it.
    - Cons: such a skill could load on a later model call of that turn.
  - **Interrupt or reload a running thread on `skills/changed`.**
    - Pros: closes the remainder.
    - Cons: a reload mid-turn would abandon the running turn, and app-server applies `skills.config` only on start or resume, so there is no cheaper way.
- **Probe hooks separately?**
  - **Add a hook canary to `live-project-trust.test.ts` (recommended, done 2026-11-06 rather than waiting for the next bump).**
    - Pros: cheap; no credentials (loopback endpoint); turns the inference into a proof.
    - Cons: one more live-gated case to maintain; the fixture has to trust each hook by hash, so a change to Codex's hook-trust format breaks the control case first.
  - **Rely on the config-layer canary.**
    - Pros: no work.
    - Cons: an inference, not a proof.

### 3. Live Grok pause and approval kinds

**Problem.** Grok is the only interaction-raising provider whose pause was never qualified, and its command/file approval mapping (item 2) and turn-clock fix (item 10) have no live evidence. The live runs need a Grok login and are in 7568; what is left here is making the spec able to prove the approval kind.

**Context.** Two attempts failed because the host Grok login had expired; a profile may not refresh a single-use refresh token.

**Investigation.** `e2e/agent-testing/paused-interactions-live.spec.ts:84-85` has `grok-question` and `grok-approval` cases. The spec accepts any of `command-approval`, `file-approval` or `permission` as an approval (:52), so it would not fail if Grok still arrived as a generic `permission`. The wait is `ORKESTRATOR_AGENT_TEST_PAUSE_WAIT_MS`, default 10.5 minutes (:41), so the 30-minute deadline check needs it raised.

**Decisions.**

- **How to prove the approval kind?**
  - **Assert `command-approval` for the Grok approval case in the spec, not the generic approval set (recommended).**
    - Pros: makes item 2's live claim automatic.
    - Cons: a spec change; Grok tool kinds could vary by prompt.
  - **Check the card kind by eye during the run.**
    - Pros: no code.
    - Cons: not repeatable.

**Done, 2026-11-13.** Built as the recommended option: the `grok-approval`
case now fails unless its approval arrives as `command-approval`
(`EXPECTED_APPROVAL_KINDS` and `approvalKindProblem` in
`e2e/agent-testing/paused-interactions-live-support.ts`, pinned by
`paused-interactions-live-support.test.ts`). The run with a Grok login is
the 7568 item.
### 7. Browser interaction checks

**Problem.** MCP elicitation rehydration, Claude's `ask` and `deny` policy overrides and a delegating coordinator turn have no real-browser evidence.

**Context.** These are the "Browser" qualification bullet. The coordinator half overlaps 0024 (retired; coordinator live conformance).

**Investigation.** The earlier note was wrong on one point: `e2e/ClaudeInteractions.spec.ts` (since #1009) already raises a Claude MCP form and URL elicitation through the real Claude bridge with a fake SDK, rehydrates it after an inactive environment and a reload from the bridge's `/session/:id/interactions` (through `HttpBridgeInteractionAdapter`), then answers and cancels it. The Claude `ask` override on a real CLI is covered by the live pause spec (Claude approval).

Done 2026-11-06 in the component browser suite (`e2e/playwright.config.ts`, headless Chromium, phone and desktop projects), with provider fakes behind the real bridges: `e2e/InteractionPolicyChecks.spec.ts`.

- Codex MCP form and URL elicitations, raised by the bridge's fake app-server (`FAKE_CODEX_SCRIPT=elicitation`) through the real Codex bridge (`e2e/fixtures/codex-elicitation-host.ts`), rehydrate after an inactive environment and a reload, then answer and cancel; the spec reads what the bridge wrote back to the child.
- A Claude session overridden to `ask`: a Bash call raises "Approve command" (it survives a reload), an Edit raises "Approve file changes", and approve, deny and cancel turn each reach the SDK's `canUseTool` callback.
- A Claude session overridden to `deny`: a Bash call is refused with "policy denies approvals" and no card, while an AskUserQuestion still shows and its answer reaches the SDK.
- A coordinator: the Claude fixture host started with `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only` reports `coordinator-read-only`, allows `mcp__orkestrator__*`, lets `launch_environment` through the read-only PreToolUse hook, refuses Write in the hook and in `canUseTool` with no card, and parks a question that survives a reload and is answered.

All 10 cases passed in three consecutive runs at the default worker count, and alongside `ClaudeInteractions.spec.ts` and `CodexHostRules.spec.ts` (18 of 18). No isolated `dev:test` profile was needed: the component suite starts no backend. A real coordinator turn on a live model is the live suite's `ask` scenario (6940, retired).

**Decisions.**

- **Split or keep together?**
  - **Cover all three here with provider fakes and leave a coordinator turn on a real model to 0024 (recommended, chosen).**
    - Pros: the browser bullet is closed without a login or a billed turn; 0024 keeps the live run it already owns, so nothing is counted twice.
    - Cons: the coordinator check proves the bridge's gate and the card, not that a real model chooses to delegate.
  - **Run the Claude `deny` and elicitation checks here and leave the whole coordinator turn to 0024.**
    - Pros: avoids any coordinator work here.
    - Cons: this file then depends on 0024 to call the bullet closed.
- **Which provider fake raises the elicitation?**
  - **The bridge's own scripted provider: the Claude SDK double for Claude, the fake `codex` app-server for Codex (recommended, chosen).**
    - Pros: deterministic, no account, no network; the elicitation crosses the real bridge parking, routes and backend mapping.
    - Cons: the MCP server itself is not in the loop, so a provider that stops forwarding elicitations would not show here.
  - **A small local fixture MCP server that elicits on a tool call.**
    - Pros: puts the MCP hop in the loop.
    - Cons: needs a real provider CLI to call it, which means a login and a billed turn.

### 8. Container cells on Cursor and Pi

**Problem.** Cursor and Pi execution-policy behaviour inside a container (sandbox `container`, firewall-enforced network) is unproven.

**Context.** The item names `mise run test:agent:docker`, which needs a profile started with `--fixture-environments container` and Cursor and Pi logins.

**Investigation.** That task only runs tests whose title contains "Docker fixture" (`mise.toml:275-279`). None of those specs (`browser-gateway.spec.ts`, `container-*.spec.ts`, `grok-container-login.spec.ts` and others) has a Cursor or Pi execution-policy case, so running the suite as written would not qualify these cells.

Done on 2026-11-06 without logins. `e2e/agent-testing/container-fake-engines.spec.ts` adds two "Docker fixture" cases. Each puts a bundle of the bridge's `src/testing/container-fake-engine-server.ts` (the real bridge over Cursor's fake SDK or Pi's faux model) in place of `/opt/<platform>-bridge/dist/index.js` in the fixture container, so the backend's production `start_<platform>_server` launch runs it. The case opens a native tab and drives it from the composer. It checks the reported policy (`interactive-container`, sandbox `container`, approvals `auto-approve`, network `restricted`) and Cursor's SDK options (cwd `/workspace`, SDK sandbox off). It checks that `https://example.com/` is refused from where the agent runs while `https://api.github.com/zen` answers. For Cursor, the fake requests the URL from the bridge process. For Pi, the faux model calls Pi's own `bash` tool, which runs `curl`. Pi also has an `ask` case: the call parks a card, nothing runs until the card is approved, then the command runs. The fakes gained `FETCH <url>` (Cursor) and `BASH: <command>` (Pi), with bridge unit tests. `test:agent:docker:isolated` now enables Cursor and Pi. Both cases passed on beelink (Linux, Docker 29.9.2, image `orkestrator-v2:dev-f199d298c1eb`). No defect in the container path itself showed up. What a real Cursor SDK or a real Pi provider does in the container is checked by the opt-in variants in `e2e/agent-testing/container-real-engines-live.spec.ts` (7040 (retired), added 2026-11-14), whose signed-in runs are in [7568](../manual-test/7568-manual-test-checklist.md).

Validation record, 2026-11-06, beelink, branch commit `381efb5cb` (before the rebase onto `main` at `295abd298`, which changed only to-do index rows on this branch): `mise run test:agent:docker:isolated` exited 0 (839 s). Playwright reported 29 Docker fixture cases: 25 passed, 4 skipped (the Claude approval, Claude terminal, Grok login and live annotation cases, each needing a live-login opt-in), 0 failed, 0 flaky. All four new cases passed: Cursor setup-failure rollback (9.9 s), Pi setup-failure rollback (9.0 s), Cursor cell (48.4 s) and Pi cell (41.4 s). The Pi cell sent without the one-time resend (no `send-refused` annotation). Docker containers and volumes on the host were identical before and after the run. The run removed its own profile's resources through `dev:reset`. The only network differences were `ork4222-churn-*` networks, which another build created and removed during the run. Nothing was pruned, Docker was not restarted and no host network setting changed.

Two earlier runs of the same task that day show what reaching that result took:

- The first failed before the browser. Electron's managed-toolchain download for Grok and Cursor goes through Chromium (`net.fetch`), which aborts with `net::ERR_NETWORK_CHANGED` when Docker adds or removes an interface. The suite's image qualifications do that just before the profile starts. An unattended profile quits on that failure. Two fixes followed. `downloadArchive` now retries a request aborted that way, even when no bytes have arrived. `dev:test` downloads the toolchains it could not seed with Bun's `fetch` before Electron starts (`prefetchAgentToolchains`). The failure is not specific to containers, but this task's change caused it: adding Cursor to the Docker task's platforms added a second Electron download.
- The second reached the browser. One unrelated case failed: a `browser-gateway.spec.ts` navigation aborted by `ERR_NETWORK_CHANGED` (flake 2340). The Pi cell also failed once. Its first prompt came back to the composer within a second and was never resent. The profile was reset before its logs could be read, so the cause is unknown ([7042](7042-pi-container-cell-first-send-refused.md)). The send step now records the visible error and the projection phase as a `send-refused` annotation. It resends once, and only when the session holds no such user message.

**Decisions.**

- **How to qualify them?**
  - **Add a "Docker fixture" case per platform that starts a Cursor and a Pi session in the container and checks the reported policy and one refused off-allowlist request (recommended; done with fake engines).**
    - Pros: makes the item runnable and repeatable.
    - Cons: new spec work and two credentials in a container profile.
  - **Manual run in a container environment.**
    - Pros: no spec work.
    - Cons: not repeatable; easy to miss a cell.
  - **Drop the item, relying on the bridge conformance tests.**
    - Pros: no work.
    - Cons: the container network path is exactly what unit tests cannot show.

### 9. Claude provider sandbox on a real CLI

**Problem.** The conformance suite proves the sandbox options are set, not that the CLI enforces them.

**Context.** `claudeExecutionSandbox` sets `allowUnsandboxedCommands` from whether the policy asks for approval and `strictAllowlist` when the network is restricted (`bridges/claude-bridge/src/services/claude-execution-sandbox.ts`, the provider branch at the end of `claudeExecutionSandbox`). On Linux without bubblewrap and socat the sandbox cannot run at all.

**Investigation.** `src/conformance-execution-policy-live.test.ts` already drove the pinned CLI through the SDK with this sandbox block, but under `bypassPermissions` with its own options, a write inside the working directory blocked by an added `denyWrite`, and a loopback request. It checks neither a write outside the workspace nor whether a card is raised. Its loopback request never reaches the sandbox proxy either: the sandbox's `NO_PROXY` names loopback and the private ranges, so such a request connects directly and only Seatbelt's network rule refuses it. `strictAllowlist` is decided in the proxy.

macOS half done on 2026-11-06 on this Mac (Darwin 27.2.0, arm64), against pinned CLI `2.1.314` (the SDK's bundled binary at Agent SDK `0.3.314`, the same version as the managed toolchain). `bridges/claude-bridge/src/services/claude-provider-sandbox.live.test.ts` runs the whole bridge in a clean process through its own routes (`app.request`, no port bound): session create with an execution policy, prompt, interactions, activity and close. HOME and `CLAUDE_CONFIG_DIR` are a temporary directory the test creates and removes, the API key is a fixture string, and the model is a scripted loopback endpoint that asks for one Bash call per turn. The bridge builds the options itself, so the permission mode, `canUseTool` and the sandbox block are the production ones. The write target is a scratch `outside` directory beside the scratch workspace. The unlisted host is a loopback server the probe starts. No `dev:test` profile, backend or app was started. Results, all asserted by the test:

| Turn | Policy | What the command did | Approval cards |
| --- | --- | --- | --- |
| `write-outside` | provider sandbox, auto-approve, restricted | `printf > outside/…` failed: `operation not permitted`; no file | none |
| `write-outside-escape` | same, with `dangerouslyDisableSandbox: true` | failed the same way; no file | none |
| `write-outside-escape-ask-accept` | provider sandbox, ask, restricted, escape requested | no file before answering; accepting allowed the outside write | Bash |
| `write-outside-escape-ask-decline` | same | no file before answering; declining returned a tool error and no file was written | Bash |
| `network-direct` (and `-escape`) | same | `curl` to the loopback server: `Couldn't connect` (Seatbelt); 0 requests arrived | none |
| `network-proxy` (and `-escape`) | same | `curl --noproxy ''` through the sandbox proxy: 403, `host is not on the allow list`; 0 requests arrived | none |
| `network-proxy-ask` | provider sandbox, ask, restricted | the Bash card approved; the request refused as above; 0 arrived | the Bash card only |
| `control-unsandboxed` | no sandbox, auto-approve, full | wrote `outside/…` and reached the server | none |
| `control-workspace-write` | provider sandbox, auto-approve, restricted | wrote inside the workspace | none |
| `control-direct-full`, `control-proxy-full` | provider sandbox, auto-approve, full | reached the server, directly and through the proxy | none |
| `control-proxy-full-ask` | provider sandbox, ask, full | reached the server after a second card | Bash, then `SandboxNetworkAccess` |

The controls are what make the refusals mean something. The same commands work unsandboxed, and a sandboxed command can still write its workspace. With `strictAllowlist` off, the same proxied request is granted unseen under auto-approve, or raises a `SandboxNetworkAccess` card under `ask`, which is the behaviour the option exists to prevent. No defect was found, so no production bridge code changed. The review follow-up added accepted and declined ask-policy escape turns, proving the write waits for approval. The expanded 14-turn check passed on 2026-11-06 in 23.1 s. It is opt-in: `mise run verify:claude:sandbox-live`, and the slow tier (`*.live.test.ts`). It skips on every platform but macOS. `docs/development/upgrade-agents.md` now runs it on a Claude bump.

Linux half done on 2026-11-10 on `beelink2` (Arch/Omarchy, kernel 7.2.15, x86_64, bubblewrap 0.13.1, socat present, no AppArmor or SELinux in `/sys/kernel/security/lsm`), against pinned CLI `2.1.319` (the SDK's bundled binary at Agent SDK `0.3.319`, equal to the managed toolchain pin). The host probe answered `{"available":true}` in 5.6 ms. The same probe and test ran unchanged apart from the gate and two platform expectations: the test now runs on Linux when the uncached `probeClaudeLinuxSandbox()` says the sandbox works (the test preload pins the cached answer), and `PLATFORM_SANDBOX_EXPECTATIONS` holds what differs per OS. Same temporary HOME, fixture key and scripted loopback model; nothing billed, no port bound by the bridge, no backend or app started. Results, all asserted by the test:

| Turn | What the command did on Linux | Approval cards | Same as macOS? |
| --- | --- | --- | --- |
| `write-outside`, `write-outside-escape` | `printf > outside/…` failed: `Read-only file system`; no file | none | Yes; the shell's message differs (Seatbelt: `operation not permitted`) |
| `write-outside-escape-ask-accept` / `-decline` | no file before answering; accept wrote it, decline returned `The user denied this tool call.` and no file | Bash | Yes |
| `network-direct` (and `-escape`) | `curl` to the loopback server: `Could not connect to server` (the command's own empty network namespace); 0 requests | none | Yes |
| `network-proxy` (and `-escape`) | through the proxy: 403, `deny network-outbound 127.0.0.1:… (host is not on the allow list)`; 0 requests | none | Yes |
| `network-proxy-ask` | the Bash card approved, then refused as above; 0 requests | the Bash card only | Yes |
| `control-unsandboxed`, `control-workspace-write` | wrote outside / inside, reached the server unsandboxed | none | Yes |
| `control-proxy-full` | reached the server through the proxy | none | Yes |
| `control-proxy-full-ask` | reached the server after a second card | Bash, then `SandboxNetworkAccess` | Yes |
| `control-direct-full` | **refused**: `Could not connect to server`; 0 requests | none | **No**: macOS reaches it |

So `allowUnsandboxedCommands: false` and `strictAllowlist` hold under bubblewrap exactly as under Seatbelt, and the controls show both refusals are the options' doing. The one difference is a documented vendor limit, not a bridge defect: `allowLocalBinding` is "macOS only" in the SDK's types, and the CLI runs each Linux command in its own network namespace, so with full network a sandboxed command reaches loopback only through the proxy, and a plain `curl localhost:…` (which `NO_PROXY` sends direct) fails. Agent Info said only "full network" for such a session; since 2026-11-11 the Claude bridge's reported policy adds a note naming the loopback exception on Linux (7563 (retired); `CLAUDE_LINUX_SANDBOX_LOOPBACK_NOTE` in `bridges/claude-bridge/src/services/claude-query-config.ts`). The 14-turn check passed three times on 2026-11-10 (15.1 s, 14.7 s, 27.5 s). A Linux host whose bubblewrap cannot nest the namespace (Ubuntu's AppArmor profile) skips it with the probe's reason; there the bridge would refuse every turn with 422, which 0145's CI pair already covers.

**Decisions.**

- **Where to run it?**
  - **macOS host and a Linux host with bubblewrap, one each (recommended).**
    - Pros: the sandbox implementation differs per OS; both are supported hosts.
    - Cons: two machines.
  - **macOS only.**
    - Pros: one run.
    - Cons: the Linux sandbox, which has more failure modes, stays unproven.
  - Chosen: both. The macOS half was done on 2026-11-06 and the Linux half on 2026-11-10, on a host with bubblewrap 0.13.1 and no AppArmor.
- **What counts as a pass?**
  - **A command that writes outside the workspace fails, and a request to a domain off the allowlist fails, with no approval card (recommended).**
    - Pros: covers both options directly.
    - Cons: needs a known-unlisted domain reachable from the host.
  - **Only the network check.**
    - Pros: shorter.
    - Cons: leaves `allowUnsandboxedCommands` unproven.

Every question, approval, elicitation and dialog a provider raises should either
reach the user through the shared interaction contract and its one generic card,
or be resolved by backend policy. The backend execution policy, not the bridges,
decides what a session may do without asking. The contract, the capability bit,
the unattended policy and the execution policy are in place, and the
per-bridge environment overrides that predated the execution policy are gone.
Since 2026-10-25 Codex questions reach the card, every countdown (Claude tmux
included) can be paused, the CLI can pause one, and Agent Info describes a
read-only turn truthfully. What is left is Grok loading a trusted
checkout's resources whatever the policy says (no switch exists on the
pinned Grok 1.0.67), and live qualification runs that need a provider login
or a person.

## Current state

- Contract (`packages/protocol/src/agent-interactions.ts`):
  - `AgentInteractionRequest.blocking` and `AgentInteractionOption.amendment`.
  - `INTERACTIVE_AGENT_INTERACTION_POLICY` and
    `UNATTENDED_AGENT_INTERACTION_POLICY`. The unattended policy declines the
    input bucket, denies the authorization bucket, and names the MCP
    elicitation kinds in its per-kind `kinds` overrides.
- Capability bit: `NativeAgentCapabilities.interactions.kinds`, set per platform
  in `nativeAgentCapabilities()` (`packages/protocol/src/native-agent.ts`).
  - Cursor reports `[]`.
  - Codex claims `question` again (item 13): interactive threads turn on
    `default_mode_request_user_input`; pipeline threads do not.
  - Pi reports its live gate through `publicInteractionKinds`
    (`bridges/pi-bridge/src/public.ts`). The backend prefers that answer over
    the table (`interactionKinds` in `http-bridge-provider.ts`).
- Unattended outcomes: every workflow owner resolves interactions through the
  shared journaled path with `agentInteractionPolicyAction`
  (`build-pipeline-service-interactions.ts`).
- Codex answers every server request (`app-server/server-request-router.ts`):
  - exec-policy and network-policy amendments are never offered or sent
    (`app-server/approvals.ts`; removed on 2026-10-27 by
    0160, because the rule each
    saves cannot be listed or revoked);
  - `serverRequest/resolved` withdraws a parked request (`event-reducer.ts`);
  - dynamic `item/tool/call` is answered as a failure, with a transcript
    explanation.
- Claude (`bridges/claude-bridge/src/services/`):
  - MCP elicitations and tool approvals are parked in one store
    (`session-manager-parked-interactions.ts`), served by
    `GET /session/:id/interactions` and answered through
    `POST /session/:id/interactions/:interactionId` (`accept`, `decline`,
    `cancel`). The backend maps them in `mapClaudeInteraction`
    (`http-bridge-interactions.ts`).
    - `onElicitation` parks `mcp-form` and `mcp-url` requests. One the card
      cannot render (a `url` request without a URL, or a schema over the text
      limit) is still declined with a status row naming the server.
    - `onUserDialog` answers `cancelled`, and `supportedDialogKinds` is
      deliberately left undeclared: the only documented kind,
      `refusal_fallback_prompt`, has an opaque payload and the card has nothing
      to show for it. The capability table therefore no longer claims
      `elicitation` for Claude.
  - `ask` and `deny` policies both run in `default`. `claudePermissionMode`
    (`claude-query-config.ts`) caps the prompt's mode there: the backend still
    sends `bypassPermissions` with every build prompt, and the bridge lowers
    it. A prompt may narrow the mode to `plan` or `dontAsk`; read-only turns
    still arrive as `dontAsk`.
  - Under `ask`, `canUseTool` (`session-manager-prompt-can-use-tool.ts`) parks
    every tool that reaches it as `command-approval` (Bash), `file-approval`
    (Edit, MultiEdit, Write, NotebookEdit) or `permission`. Only reading tools
    are pre-approved.
  - Under `deny`, `canUseTool` refuses every tool that reaches it, after
    questions and plan approvals are handled. That is what `dontAsk` does,
    except that the pinned CLI (SDK 0.3.296) refuses AskUserQuestion outright
    in `dontAsk` without consulting `canUseTool`, so a coordinator could not
    ask the user anything. A real-CLI probe with a loopback model showed a
    coordinator in `default` running its whole allow list (Read, Glob, Grep,
    read-only Bash, Agent, ToolSearch, `mcp__orkestrator__*`) with only
    AskUserQuestion reaching the callback; Write, Edit, WebFetch and mutating
    Bash stayed refused, in subagents too.
  - Under `auto-approve` a tool that reaches `canUseTool` runs.
  - An approval never returns the SDK's permission `suggestions`, because no
    revoke surface exists and returning them "would silently widen permissions
    after an allow-once decision". `approve-for-session` is refused. Decided
    on 2026-10-25 (item 1): Claude offers no "always allow".
  - AskUserQuestion option previews: the query sets
    `toolConfig.askUserQuestion.previewFormat: "markdown"`, and the question
    card shows an option's `preview` verbatim in a monospace block (item 3).
  - Denials are recorded on the tool row or as a status row
    (`handlePermissionDenied`, `session-manager-prompt-handlers/system.ts`).
    `NativeAgentContextUsage` carries `permissionDenials` and
    `permissionDenialDetails`.
- Grok: `publicApprovals` (`bridges/acp-bridge/src/acp-public.ts`) reports each
  ACP permission request in ACP's own shape (title from `permissionTitle`,
  plus the agent's options), which the native branch of `mapAcpApproval`
  offers as a required choice. `permissionDetail` (`acp-session.ts`) adds the
  kind: `command` with the command for an `execute` call, `file-change` with
  its paths for `edit`, `delete` or `move`, `permission` otherwise or when
  that detail is missing. The backend maps them onto `command-approval`,
  `file-approval` and `permission`. While any request is held, `/activity` answers
  `waiting`. Plan approvals and questions use the separate
  `x.ai/exit_plan_mode` and `x.ai/ask_user_question` reverse requests.
- OpenCode: `OpenCodeProvider` never answers a permission or question
  itself; every OpenCode interaction goes through the same journaled path as
  everyone else (item 5 removed the auto-reject branch and its option).
- Execution policy:
  - Resolved once per session by `resolveNativeAgentExecutionPolicy`
    (`apps/backend/src/core/native-agent-execution-policy.ts`).
  - Defaults for host and pipeline sessions: `sandbox: "none"` and
    `approvals: "auto-approve"`. Containers get `sandbox: "container"`, project
    resources on, and the environment's network mode. The coordinator always
    gets `coordinator-read-only`, which cannot be overridden.
  - Overridable per environment (`executionPolicy` in
    `EnvironmentSettingsDialog.tsx`). An override cannot claim a container a
    host lacks, and a container session reports the network its firewall
    enforces, which follows the environment (`reconcileContainerBoundary`).
  - Shown in Agent Info through `describeNativeAgentExecutionPolicy`
    (`AgentInfoButton.tsx`), which renders the policy's effects
    (`nativeAgentPolicyEffects`, `packages/protocol/src/native-agent-policy-effects.ts`)
    from the policy each bridge reports. A bridge reports what it applies:
    Cursor, Pi, Grok and OpenCode rewrite an axis they cannot honour and
    say why in `note` (`withoutProviderSandbox`, `acpReportedPolicy`,
    `effectiveOpenCodePolicy`). Codex honours project resources off with a
    per-thread untrusted pin and disabled repo skills (item 6), so it reports
    the policy unchanged. While a read-only turn applies, Claude, Cursor and
    Grok report the read-only policy with `READ_ONLY_TURN_POLICY_NOTE`
    (item 7).
  - Held to the adapters by the execution-policy conformance suite
    (`tests/conformance/execution-policy/`). For each platform and ten policy
    shapes it captures the options the SDK or CLI receives, decodes them into
    the same effects and compares them with the summary. The only tolerated
    differences are the stricter ones listed in `narrowings.ts`.
- Pausing a countdown. Clicking the timer on a native question, plan, command,
  file or permission card pauses the deadline where it is enforced, and
  clicking again restarts a fresh window:
  - Every bridge timer is an `InteractionDeadline`
    (`packages/protocol/src/agent-interaction-deadline.ts`). A pause re-arms it
    at `AGENT_INTERACTION_HOLD_CEILING_MS` (24 h) or the provider's own sooner
    limit, so an unanswered request is still declined in the end and older
    backends, which require a deadline, keep the card.
  - Bridges publish `hold` (`AgentInteractionHold`) beside `expiresAt` and serve
    `POST /session/:id/{family}/:requestId/hold` with `{ held }`. The backend
    calls it through `holdInteraction` (`http-bridge-interactions.ts`) and the
    `hold_native_agent_interaction` command. A bridge that publishes no `hold`
    is mapped to `bridge-outdated`: the countdown shows but is not clickable.
  - Limits: Grok stops its turn clock while a request is held, so a pause
    runs to the hold ceiling (item 10), but a question still ends at a
    `ask_user_question` timeout the user configured for Grok, which the card
    shows as the provider limit; Pi until its turn
    budget; a Codex question with `autoResolutionMs` until then; MCP prompts
    pause but warn that their server may stop waiting first. OpenCode publishes
    no deadline, so there is nothing to pause.
  - Claude in tmux pauses through a hold sidecar its hook script honours
    (`claude_tmux_hold_hook`, item 9). A hook installed by an older backend,
    or a Claude CLI started before the upgrade, keeps an unpausable
    countdown (`hook-outdated`).
  - The public CLI and API list `hold` and pause or resume a countdown
    (`session interactions hold`, `session.interaction.hold`; item 11).
  - Qualified live on Claude (question and command approval), Codex (command
    approval), OpenCode (question and permission) and Pi (command approval):
    each was left pending for 11 minutes, then answered after a reload, and its
    turn finished with the answer (live pause record below). Grok is not
    qualified yet.
- No bridge reads the old execution-policy env overrides
  (`CURSOR_BRIDGE_SANDBOX`, `CURSOR_BRIDGE_PROJECT_SETTINGS`,
  `PI_BRIDGE_REQUIRE_APPROVAL`, `PI_BRIDGE_PROJECT_RESOURCES`,
  `ACP_APPROVE_PROJECT_MCPS`) and no launcher sets them (item 4).

## Outstanding work

### Code

1. **"Always allow" and saved rules.** Done 2026-10-25 (decision). Claude
   does not offer `permission-grant` amendments: an approval still never
   returns the SDK's `suggestions`, and `approve-for-session` stays refused,
   so nothing Claude approves outlives the call (decision 1 below). That
   leaves Codex's exec-policy and network amendments as the only path to a
   saved rule. Orkestrator cannot list or revoke those, so the read and
   revoke surface (`NativeAgentPermissionRule`, the `permission-rules`
   routes, `listPermissionRules?` / `removePermissionRule?`) moved to
   `0160-codex-saved-rules-list-and-revoke.md`,
   which dropped the amendment options instead (2026-10-27): no Orkestrator
   approval saves a rule now.
2. **Grok approval kind.** Done 2026-10-22. The bridge derives the kind from
   the ACP `toolCall.kind` (or the kind it recorded for the same call, or a
   known tool name such as `bash`, reading through Grok's `use_tool`
   wrapper) and publishes `command` with the command or `file-change` with
   the paths; the backend maps them onto `command-approval` and
   `file-approval` and keeps the agent's own options as the choices. `delete`
   and `move` count as file changes as well as `edit`. A request without the
   command or paths stays a `permission`, and so does one from an older
   bridge. Tests: `acp-permission-detail.test.ts`, `acp-provider.test.ts`.
   Not done: ACP defines no blocking hint, so none is carried. Not checked
   against a live Grok request (the host Grok login was expired); the Grok
   live qualification below should confirm that real `execute` and `edit`
   requests arrive as command and file approvals.
3. **Claude question previews.** Done 2026-10-25. Every Claude turn sets
   `toolConfig: { askUserQuestion: { previewFormat: "markdown" } }`
   (`session-manager-prompt-query.ts`; `html` refused, decision 2). An
   option's `preview` is carried as `AgentInteractionOption.preview` (new,
   optional, bounded like a description), at most 4,096 characters each and
   32,768 per request; past that the request keeps its options and drops every
   preview, so a long preview can never push a question over the snapshot
   bound (`withinClaudePreviewBudget` in `http-bridge-interactions.ts`). Both
   cards show it verbatim in a monospace block, never as Markdown or HTML
   (`NativeAgentQuestionCard`, `NativeAgentInteractionCard`). Older clients
   ignore the field; only the backend validates options strictly. Tests:
   `session-manager-parked-interactions.test.ts` ("asks for question previews
   as Markdown"), `agent-provider-interactions-claude.test.ts` ("Claude question
   previews are carried within their budget"), `NativeAgentQuestionCard.test.tsx`
   ("shows an option's preview verbatim"). Not checked against a live model:
   whether Claude actually emits previews for a plain question.
4. **Retire the deprecated policy env overrides.** Done 2026-10-22. Cursor
   and Pi read only the session's policy (`sandboxEnabled`,
   `resolveCursorSettingSources`, `approvalsEnabled` and
   `projectResourcesEnabled` are gone, and a session without a policy runs as
   the host default). `cursorMcpServers` opens `.cursor/mcp.json` only when
   the policy turns `projectResources` on. The launchers in
   `commands-servers.ts`, `host-model-catalog-refresh.ts` and
   `pi-model-catalog-seeding.ts` no longer set the variables; coordinators stay
   closed through `ORKESTRATOR_BRIDGE_EXECUTION_POLICY`. The comments, both
   `AGENTS.md` files and `platform-inconsistencies.md` are updated, and no
   source file outside tests names any of the five variables. Tests that set
   them now check they change nothing.
5. **Delete the unused OpenCode auto-answer branch.** Done 2026-10-25. The
   `autoAnswerRequests` option is gone from `ProviderCommonDependencies` and
   `OpenCodeProviderDependencies`, and with it the `permission.asked` /
   `question.asked` replies, the pending-request reconciliation in
   `registerSession` and on stream start, and the `blockedSessions`,
   `failedQuestionSessions` and `answeringRequestIds` state they fed. The
   provider-level `onInteractionObservation` hook fired only from that
   branch, so it went too, along with its wiring through the build pipeline,
   looped review and `index.ts` and the tracker's provider-reported
   observation path (`recordProviderInteractionObservation`,
   `providerReportedInteractions`, `PROVIDER_REPORTED_INTERACTION_GRACE_MS`).
   The interaction monitor now sees only what its sweep reads. Tests that
   drove the branch were deleted; "leaves OpenCode permissions and questions
   pending for the journaled path" (`opencode-provider-lifecycle.test.ts`,
   removed with OpenCode 1.x on 2026-11-11:
   `git show 5f4e27b1c:apps/backend/src/core/opencode-provider-lifecycle.test.ts`)
   checked that even an unattended registration gets no provider-side reply.
   A future owner that wants provider-side answering should follow
   `agentInteractionPolicyAction` instead of always rejecting.
6. **Codex project resources.** Done 2026-10-22. With project resources off,
   every `thread/start`, `thread/resume` and `thread/fork` carries
   `config.projects[<cwd>].trust_level = "untrusted"` (and the cwd's canonical
   path) as a nested table, plus a thread-scoped `skills.config` that disables
   every repo-scope skill `skills/list` reports, because the pin does not reach
   skills. A `skills/list` failure other than method-not-found refuses the
   thread. `codexReportedPolicy` is deleted and the conformance suite reads the
   pin. Checked against the pinned 0.162.1 with a loopback Responses endpoint
   (`live-project-trust.test.ts`, gated by `RUN_LIVE_CODEX_APP_SERVER=1`, no
   credentials): with the project trusted, the `.codex` config layer, AGENTS.md,
   `.codex/skills` and `.agents/skills` all reach the model and the project MCP
   server is contacted (control); with the pin none of them do, on the first
   turn and after a reload, a pin on a linked worktree wins over a trusted main
   checkout, and the user's `config.toml` is left unchanged. A dotted
   `projects."<path>".trust_level` key in thread config is silently ignored.
   The three residual risks first recorded here were worked through by
   2026-11-06 (task 2):
   - A repo skill added while a thread is loaded is disabled before the next
     turn: `skills/changed` makes the next prompt resume the thread with the
     new exclusions. Kept as residual risk: a skill written during a running
     turn can reach the rest of that turn.
   - The slash-command catalogue marks repo skills unavailable for a session
     with project resources off and the bridge refuses their dispatch
     (#1147).
   - Hooks are probed on their own: with the project trusted and each hook
     trusted by hash, `SessionStart` and `UserPromptSubmit` hooks run; with
     the pin none do (`live-project-trust.test.ts`, Codex 0.166.0).
7. **Read-only turns.** Done 2026-10-25. Claude, Cursor and Grok now report
   the read-only policy while it applies, marked with
   `READ_ONLY_TURN_POLICY_NOTE` (`readOnlyTurnReportedPolicy` in
   `native-agent-policy-effects.ts`): Claude while a turn started with
   `readOnly` is running (`claudeReportedPolicy`, from
   `commandDiscoveryInputs.readOnly`), Cursor and Grok while the session's
   `readOnly` flag is set, which a later prompt clears (`cursorAppliedPolicy`
   in the new `cursor-bridge/src/execution-policy.ts`, shared with `attach`;
   `acpSessionReportedPolicy`). Tests: `claude-query-config.reported-policy.test.ts`,
   `public-policy.test.ts` (Cursor), `acp-reported-policy.test.ts`.
8. **Codex `on-request` in a container.** Done 2026-10-25 (decision 4).
   The composer describes the mode honestly rather than mapping it to
   `untrusted`: in a container under `auto-approve`, `on-request` reads
   "…so this never asks; choose Untrusted to approve commands" and
   `auto-review` says its reviewer is never consulted; under `ask` it says it
   asks like Untrusted, which is what `codexApprovalConfig` runs
   (`CODEX_CONTAINER_APPROVAL_DESCRIPTIONS` in `native-agent.ts`; the launcher
   passes the policy's `sandbox`, `AgentNativeTab.helpers.tsx`). Tests:
   `native-agent.test.ts`, `AgentNativeTab.test.tsx`.

9. **Pause in Claude tmux mode.** Code done 2026-10-25; live check in 7568.
   - The three blocking hooks (PreToolUse, PermissionRequest, Elicitation)
     run as `bash hook.sh <Kind> hold-v1` with `timeout: 172800` (two hold
     ceilings), so Claude Code no longer kills them at 600 s.
   - With `hold-v1` the script writes a version-2 timing file (`startedAt`,
     `expiresAt`, `limitAt` = start + 172,740 s, `heldAt` while paused) and
     its wait loop consumes `<session>/hold/<Kind>-<id>.json`: a pause moves
     the deadline to the earlier of now + 24 h and `limitAt`, a resume to a
     fresh five-minute window. Without the argument it writes the old shape,
     which stays unpausable (`hook-outdated`): an installed script that
     predates the sidecar, or a CLI started before the upgrade.
   - `parseBlockingHookTiming` accepts a moved deadline only when it is
     consistent with `startedAt`/`heldAt` and `limitAt`.
   - Command `claude_tmux_hold_hook` writes the request, waits up to 5 s for
     the script to rewrite the timing, then re-emits the same `hook` frame
     with the new `expires_at` and `hold`. If the script does not answer, it
     withdraws the request and the prompt keeps its old deadline (fail
     closed). Answering, expiry and the drain remove the hold file.
   - Cards use `usePromptHold`; `TMUX_PROMPT_DEADLINE` is gone.
   - Tests: `apps/backend/tests/tmux-hook-hold.test.ts` runs the generated
     script (pause, resume, answer, expiry after resume, unpausable without
     the argument); web store, client, card and tab tests.
   - Still owed: a real Claude CLI honouring a 172,800 s hook `timeout`
     without clamping it, and a paused PermissionRequest surviving past 600 s
     (no documented maximum was found; a clamped hook is killed, which stops
     the tool call, so it still fails closed). Moved to 7568 (0001 task 5).
10. **Pause Grok past its own limits.** Done 2026-10-25 in code and against
    the pinned binary; the live pause through the app is owed (7568, 0001 task 3).
    - The `session/prompt` timeout is now a clock that stops while any parked
      request is held and restarts with the time it had left when the last
      hold ends or the held request settles (`acp-prompt-clock.ts`,
      `syncPromptTurnClock`; `AcpProcess.request` takes an `onTimeoutArmed`
      callback so the timeout can move). A resumed request always gets at
      least its fresh five-minute window. While stopped, a backstop sits at
      time left + 24 h, after any held request must have expired. A held
      approval or plan approval therefore runs to the 24 h ceiling instead of
      the turn deadline.
    - Grok's own question timeout is resolved at spawn in Grok's order
      (`/etc/grok/requirements.toml`, then the environment, then
      `$GROK_HOME/config.toml` `[toolset.ask_user_question]`;
      `acp-question-timeout.ts`). When nothing sets it, the child gets
      `GROK_ASK_USER_QUESTION_TIMEOUT_SECS=86400` and the bridge's deadline
      decides; a value or off switch the user set is left alone and
      published as the card's provider limit (decision 13).
      `managed_config.toml` is not read: Grok syncs it from the team and
      deleted a hand-written copy in the probe.
    - Tests: `acp-prompt-clock.test.ts`, `acp-question-timeout.test.ts`,
      `acp-request-rearm.test.ts` (a real `AcpProcess` timeout moved earlier
      and later against an agent that never answers), `acp-context.test.ts`
      (the spawned child's environment), `acp-prompt.test.ts`.
    - Evidence: Grok 1.0.67 (`2fe064390d07`, the pin) against a loopback
      model in a throwaway `GROK_HOME`, no credentials: the ask arrives as
      `_x.ai/ask_user_question` with no timeout in it; Grok abandoned it at
      8 s with the environment set to 8, at 5 s with the user config set to
      5, and at 9 s with environment 9 over config 5; with 86400 it was still
      pending at 1,950 s, past the 1,800 s default. Longer was not run.
11. **Pause from the public CLI and API.** Done 2026-10-25. Each item in
    `session.interactions` carries an optional `hold` (`available`,
    `heldAt` while paused, `reason`), and `session interactions list` prints
    whether each countdown is paused, pausable or not and why. The new
    `session.interaction.hold` action (`held: true|false`; CLI
    `orkestrator session interactions hold SESSION INTERACTION [--resume]`)
    calls `hold_native_agent_interaction`. It refuses before any provider call
    when the interaction is missing or expired (`interaction-stale`), has no
    countdown, or its pause is unavailable (`unsupported`, with
    `details.reason`, `bridge-outdated` when no `hold` is published); asking
    for the state it is already in returns applied. Request keys are scoped
    like resolve's, the intent is `{held}`, and no `expectedRevision` is
    required (decision 6). Control MCP reaches it through `run_action` (no
    voice confirmation: a pause approves nothing). Tests:
    `public-api-interaction-hold.test.ts`; docs in `public-cli.md` and
    `cli-testing.md`.
12. **Grok project resources off.** Open: blocked on xAI. When the policy
    turns project resources on, the ACP bridge launches Grok with
    `GROK_FOLDER_TRUST=0` (`acp-provider-config.ts`). When it is off, which is
    the host default, Grok still loads the AGENTS.md, skills, commands, hooks
    and MCP servers of a checkout whose main repository the user trusted in
    Grok, and `acpReportedPolicy` reports the axis as on with a note. No
    switch forces Grok's gate closed.
    - 2026-10-22, Grok 1.0.52: a search of the binary found only switches
      that open the gate (`GROK_FOLDER_TRUST=0`, `--trust`,
      `[folder_trust] enabled = false`).
    - 2026-10-25, Grok 1.0.67 (the pin), isolated `GROK_HOME`, loopback model:
      `_x.ai/hooks/list` reports `projectTrusted` without a model turn. A
      repo granted with `--trust` reports `true`, and so does a `git
      worktree` of it with no grant of its own (the leak); a never-granted
      repo reports `false`. On the trusted worktree it stayed `true` with
      `GROK_FOLDER_TRUST=1`, with `_meta {"x.ai/folderTrust": …}` (`false`,
      `true`, `"untrusted"`, `{trusted:false}`, `{enabled:true,
      trusted:false}`) on `session/new` and `false`/`true` on `initialize`,
      and with a `trusted = false` entry for the worktree in
      `trusted_folders.toml` (a store write the bridge must not make
      anyway). `strings` of `grok-native` shows `GROK_FOLDER_TRUST` as the
      only `GROK_*` trust variable; the `GROK_CONFIG` overlay is documented as
      unable to "elevate trust" and covers only models, features, toolset and
      part of the shell policy; untrusting (`/hooks-untrust`,
      `x.ai/hooks/action`) rewrites the user's `~/.grok/trusted_folders.toml`.
    - The only mechanism that works is a throwaway `GROK_HOME`, which drops
      the user's config, skills, MCP servers and the session store
      `session/load` reads. Not shipped (decision 14).
    - To close: xAI adds a per-process "never trust" switch (an environment
      variable or a `session/new` meta key; requested in
      [`docs/upstream-issues/grok-never-trust-switch.md`](../../upstream-issues/grok-never-trust-switch.md)), or a live qualification of a
      throwaway `GROK_HOME` with `GROK_AUTH_PATH` pointed at the real login,
      with resume checked. Then honour `false` and drop the note, as item 6
      did for Codex.
13. **Codex questions never reach the card.** Done 2026-10-25 in code and
    against the pinned binary; a real-model run is owed (7568, 0001 task 4).
    Every `thread/start`, `thread/resume` and `thread/fork` of a session with
    a policy other than `pipeline` sets
    `features.default_mode_request_user_input = true`
    (`codexRequestUserInputConfig` in `codex-config.ts`), so Default mode no
    longer refuses `request_user_input` and the call parks as a question card.
    Pipeline threads keep the refusal (decision 3). `question` is back in the
    Codex row of `nativeAgentCapabilities()`, and
    `paused-interactions-live.spec.ts` has a `codex-question` case. Evidence:
    `live-request-user-input.test.ts` (`RUN_LIVE_CODEX_APP_SERVER=1`, the
    managed Codex 0.164.0 against a loopback Responses endpoint, no
    credentials) passes twice over: an interactive-host thread's call parks
    as `item/tool/requestUserInput`, can be paused, and the answer reaches the
    model as the tool output with no resample in between; the `pipeline`
    control still gets "unavailable in Default mode". With the config
    removed the first case fails, so the test is not passing by accident.
    Codex sends these questions with `isBlocking: false` but still waits for
    the answer; since `0161-codex-default-mode-question-activity.md`
    (2026-10-27, deleted 2026-11-06) the bridge publishes them as blocking, so
    the session shows as waiting.
    `upgrade-agents.md` now runs the live test on every Codex bump, because
    the feature is marked under development and could be renamed.

### Qualification

- The live runs (Grok pause and approval kinds, a Codex question, a Claude
  tmux pause past 600 s, Claude question previews) need real logins and moved
  to 7568 on 2026-11-10 (tasks 3 to 6). What stays is task 3's spec
  assertion.
- ~~Browser: raise an MCP elicitation (Codex or Claude), answer it, reload
  mid-question, and confirm it rehydrates from `/session/:id/interactions`. On
  a Claude environment overridden to `approvals: "ask"`, confirm a Bash or Edit
  call raises an approval card and that approve, deny and cancel turn reach the
  CLI. On one set to `deny`, confirm a tool outside the allow list is refused
  without a card while a question still appears. Run a real coordinator turn
  that delegates and asks a question.~~ Done 2026-11-06 with provider fakes
  (task 7): `e2e/ClaudeInteractions.spec.ts` and
  `e2e/InteractionPolicyChecks.spec.ts`. A coordinator turn on a real model
  is left to 0024 (retired), now the live suite's `ask` scenario.
- ~~`mise run test:agent:docker` for the container cells on Cursor and Pi.~~
  Done 2026-11-06 with fake engines (task 8); the live-provider variants
  are `e2e/agent-testing/container-real-engines-live.spec.ts` (7040 (retired)), run from
  [7568](../manual-test/7568-manual-test-checklist.md).
- ~~On a real Claude CLI, confirm that a provider-sandboxed auto-approve session
  can neither leave the sandbox (`allowUnsandboxedCommands: false`) nor reach a
  domain off its allowlist when the network is restricted (`strictAllowlist`).
  The conformance suite proves the options; only the CLI proves the behaviour.~~
  Done (task 9): macOS on 2026-11-06, Linux (bubblewrap) on 2026-11-10, with
  `mise run verify:claude:sandbox-live`.

### Live pause record (2026-10-21)

`e2e/agent-testing/paused-interactions-live.spec.ts` (procedure in
[agent-testing.md](../../development/agent-testing.md#live-paused-interactions))
ran on `9b3f53a2` plus this change, in the disposable profile `qa-pause-0640`
(macOS arm64, load average about 20). The profile authorized Claude, Codex,
Grok, OpenCode and Pi, with pinned CLIs claude 2.1.296, codex 0.162.1,
opencode 1.19.0 and pi 1.2.0. Each case had its own local environment under
`approvals: "ask"` and its own real turn. All six were raised within seven
seconds of each other and held together.

| Case | Request | Pause from the card | After 11 min | Answer (after reload) | Turn |
| --- | --- | --- | --- | --- | --- |
| Claude question | `question` (AskUserQuestion) | Paused, deadline moved to +24 h | Pending, turn waiting | Picked `PAUSE_BETA` | Finished with `CODEWORD_CHOSEN=PAUSE_BETA` |
| Claude approval | `command-approval` (Bash `touch`) | Paused, +24 h | Pending, no marker file | **Approve** | Marker created, finished with the done token |
| Codex approval | `command-approval` (`untrusted`) | Paused, +24 h | Pending, no marker file | **Approve** | Marker created, finished |
| OpenCode question | `question` | No countdown shown (no deadline published) | Pending, turn waiting | Picked `PAUSE_BETA` | Finished with the codeword |
| OpenCode approval | `permission` (bash) | No countdown shown | Pending, no marker file | **Approve once** (not "Always allow") | Marker created, finished |
| Pi approval | `command-approval` | Paused to its 6 h turn budget (`provider-limit`) | Pending, no marker file | **Approve** | Marker created, finished |

The spec checked every 60 s that each request kept its id and stayed
`pending`, that no turn went `idle` or `error`, and that no marker file
appeared. The answers were given only after a fresh sign-in and a reload, so
each card was rehydrated from the backend. The Playwright run passed in
675 s (`mise run test:logged -- --name paused-interactions-live`, results in
`output/agent-testing/qa-pause-0640/browser/results.json`). No silent
timeout, auto-deny or auto-approve was seen on any provider. Earlier one-minute
shakedowns showed the same behaviour.

Not qualified:

- **Grok.** The host Grok login had expired, and a profile may not refresh it
  (refresh tokens are single-use), so the launcher seeded nothing. It is
  tracked as its own qualification item above.
- **Codex question.** No real Codex turn can raise one (Code item 13).
- **Cursor.** It raises no interactions (`interactions.kinds` is `[]`).

Found on the way, none of them in the pause path:

1. Codex refuses `request_user_input` in every Orkestrator turn (item 13).
2. Two OpenCode servers starting in the same second can lose one to `database
   is locked`. Fixed 2026-10-23 in
   [0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md):
   host OpenCode starts are serialised and a locked start is retried. The
   "silent wait" was this spec ignoring a refused dispatch, which it now
   fails on at once. The spec still starts a provider's cases one after the
   other.
3. A harness bug selected the Codex card's optional "Approve with command
   policy", which wrote a durable rule into the host's
   `~/.codex/rules/default.rules`, because a profile shares the host Codex
   home. The product behaved as designed: only that explicit choice sends
   `acceptWithExecpolicyAmendment`, and **Approve** alone sends `accept`. The
   spec now never picks an optional or amendment option. The file, created by
   the run, was removed. The isolation gap is recorded under
   [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
   item 4.
4. An early approval prompt passed an absolute path containing a space
   (`Application Support`), and one agent created an empty `~/Library/Application`.
   That file was removed, and the prompts now use a bare file name in the
   worktree.
5. In a profile, Pi falls back to `gpt-4`, because only Pi's `auth.json` is
   shared, not the host's default model. A ChatGPT-backed OpenAI login refuses
   that model, so the spec defaults Pi to `openai/gpt-6-sol`.

Decisions:

- **How to drive it.** Options: drive the browser by hand, write a
  backend-only script, or add an opt-in Playwright spec. We added the spec.
  The pause and answer go through the real card, the run can be repeated for
  Grok later, and the wait is checked continuously rather than once. The
  dispatches go through the backend command the compose bar uses, because
  typing six prompts would not change what is under test.
- **Parallelism.** One environment per case, all held together, so the run
  takes about 12 minutes for six cases rather than 66.
- **Wait.** 10.5 minutes after the last request was raised, which is past the
  old five-minute default and Claude's 600 s hook limit. Every case had in
  fact waited 11 minutes when it was answered.

### Review rerun (2026-10-21)

The review fixes were validated on base `5f290e5c` plus the review changes in
profile `qa-pause-review-2a03`, using the same pinned provider CLIs as the
record above. The new `test:agent:paused-interactions` mise task keeps the
live qualification separate from credential-free default tests.

- The full 10.5-minute live qualification passed in 678.6 seconds, using:

  ```bash
  ORKESTRATOR_AGENT_TEST_PROFILE=qa-pause-review-2a03 \
    ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1 \
    ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=claude,codex,opencode,pi \
    ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=90000 \
    mise run test:logged -- --name paused-interactions-review-live -- \
    mise run test:agent:paused-interactions
  ```

  All six cases in the table above stayed pending for about 11 minutes and
  finished with their expected answer after reload: Claude question/approval,
  Codex approval, OpenCode question/permission, and Pi approval. Every timed
  request was held immediately on arrival, then resumed and paused through
  its enabled card controls. Both OpenCode cards were visibly mounted before
  asserting no countdown. The 10.5-minute wait began after all card checks,
  so every UI hold itself received the full qualification interval. No marker
  appeared before approval; no pending interaction remained after completion.
  Results: `output/agent-testing/qa-pause-review-2a03/browser/results.json`.
- Cleanup was tested against real fixture environments by injecting failures
  immediately after creation and after startup, before layout persistence:
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-pause-review-2a03
  ORKESTRATOR_AGENT_TEST_RUN_ID=qa-pause-review-2a03-cleanup
  ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1 mise run test:logged --
  --name paused-cleanup-live -- mise run test:agent:paused-interactions --grep
  'setup failure'`. Both cases passed. Both stop/delete commands were attempted,
  the environment records disappeared, and the started worktree was removed.
- The 13 credential-free helper regressions cover optional choices, amendments,
  allow-once preference, unsafe choices, setup/cleanup failures, immediate holds
  despite delayed providers, and draining providers before cleanup. They now
  run in the default `mise run test`, alongside the existing heartbeat tests.
- The separate Grok attempt used `ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=grok`
  and run ID `qa-pause-review-2a03-grok`. It **failed qualification** after
  303 seconds: no question became pending. The launcher had reported that the
  host Grok login was expired and could not be refreshed by an isolated profile.
  The question and permission cases remain unqualified; neither is counted as
  passed. Five one-minute heartbeats kept the 300-second raise poll alive under
  `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=90000`; the failure was the assertion
  timeout, not the watchdog. Its environments were cleaned up. Failure logs:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.p0WoNb`.
- `mise run test:logged -- --name full-non-ios -- mise run test` passed
  in 554.6 seconds. Format, lint and all typechecks passed through `mise run
  check`; the changed TypeScript files also linted with zero warnings.
  Focused task, heartbeat, helper and Playwright-loading checks passed, and
  `mise tasks validate` accepted all 79 tasks. Other platform scenario suites
  were omitted because only the qualification harness, task wiring and docs
  changed; the real browser paths are exercised by the live qualification.
- Codex question qualification remains blocked by the Default-mode limitation
  in item 13 above. The approval qualification does not imply question coverage.
  Enabling a different Codex collaboration mode is a product change outside
  these harness fixes. No passing Codex question result is claimed.

The disposable profile was stopped and reset after validation. The initial
rerun exposed a harness race between optimistic countdown labels and a still
pending resume action; waiting for the authoritative resumed state and an
enabled pause button fixed it before the successful qualification above.

## Constraints and rationale

- Approvals fail closed. A timeout, disconnect or unparseable answer denies.
- Unattended `command-approval` and `file-approval` are `deny-and-fail`; MCP
  elicitations are `decline-and-continue`, because MCP defines `decline` as an
  outcome the server handles.
- `permission` stays `deny-and-fail` when unattended. Codex uses that kind for a
  genuine capability escalation, but OpenCode puts per-tool approvals on it: an
  unattended OpenCode session refused file edits would carry on producing
  nothing. Telling the two apart belongs in the execution policy, not in a
  per-kind default. The reasoning is in the `UNATTENDED_AGENT_INTERACTION_POLICY`
  comment.
- An allow-once decision must never widen durable permissions. No "always
  allow" option ships without a way to list and revoke what it saved.
- Bridges translate the policy; they never decide trust. They cannot reliably
  tell a host from a container.
- A prompt's permission mode may narrow an `ask` or `deny` policy (plan mode,
  a read-only turn's `dontAsk`) but never widen it.
- `deny` is enforced by `canUseTool` in `default`, not by `dontAsk`, so a
  denying session can still ask the user questions.
- The coordinator policy is not user-overridable.
- Hosts default to no sandbox and auto-approve because every vendor sandbox
  holds `.git` read-only, which stalls ordinary Git work in a worktree (#613).
  `ask` stays available as an override.
- Key entry and other secrets go through an interaction, never a renderer form.
- Agent Info's policy summary is checked against what each adapter actually
  sends, not by a one-off look. The decisions behind that check:
  - One semantic model (`NativeAgentPolicyEffects`: isolation, approvals,
    project resources, network and what holds a network restriction) is both
    what the summary renders and what each runner decodes the received options
    into. No test compares summary strings.
  - The summary describes the policy the bridge reports, and the bridge reports
    what it applies. An axis an agent cannot honour is rewritten to the truth
    with a `note`, at report time only, so no gate or persisted policy changes.
    The alternative, a per-platform caveat table in the renderer, would have
    put provider knowledge back in the web app.
  - Runners capture the real hand-off (Claude's mocked `query()` options,
    Codex's `thread/start` and `turn/start` requests plus its `-c` overrides,
    Cursor's `Agent.create` options, Pi's loader options and approval gate,
    Grok's command line and permission answers, OpenCode's `session.create`
    rules). Approvals are observed behaviourally: each runner hands its gate an
    action nothing pre-approved and records whether it asks, refuses or runs.
  - An adapter may be stricter than its summary only where `narrowings.ts`
    says so with a reason. The suite fails if a narrowing is looser, or if it
    stops being observed, so an entry cannot outlive its cause.
  - "Restricted network" means the agent's own commands. Hosted tools that
    reach the internet without running a command here (web fetch, web search)
    are described by the effects model's network denial and hosted-search
    exception; the provider network-policy tests verify their tool restrictions.
  - A provider sandbox that the model can leave unseen holds nothing, so
    Claude only offers the way out (`allowUnsandboxedCommands`) when a person
    approves it, and a restricted sandbox uses a strict allowlist.

## Open questions

All answered on 2026-10-25; the reasoning is in the decisions below.

- ~~Pi, Grok and OpenCode have no sandbox of their own, so a `provider`
  sandbox or a restricted network on a host runs unsandboxed with full
  network access, reported as such with a note. Should the backend refuse such
  a session, as Cursor refuses `deny`, rather than run it?~~ No (decision 5).
- ~~Should Orkestrator expose "always allow" at all, given there is no revoke
  UI yet?~~ Not for Claude (decision 1). Codex's amendment options were
  removed by 0160 on
  2026-10-27.
- ~~`previewFormat`: plain or html?~~ `markdown`, shown verbatim (decision 2).
- ~~Claude MCP OAuth: is the parked `mcp-url` card the intended route for
  that sign-in, or should MCP management own a separate flow?~~ The parked
  card, while a Claude CLI is live; with none, the sign-in action is refused
  with a message rather than reconnecting on a probe whose link reaches no
  one (decision 7, `performSessionMcpAction`; `mcp-management.md` "Claude MCP
  sign-in").

## Needs verification

- ~~Whether every bridge has per-kind tests for park, render, resolve and
  fail-closed timeout.~~ Checked 2026-10-25. Every provider has park,
  render, resolve and timeout tests for its main kinds; the cells without one
  (kinds that share another kind's timer, `mcp-url` expiry, some backend
  mapping fixtures and bridge-route listings, OpenCode abort) got their tests in
  todo 0162 (retired on 2026-10-29; see
  [agent-engines.md](../../architecture/agent-engines.md#interaction-deadlines-and-pausing)).
  The audit also found OpenCode's capability row claiming `command-approval`
  and `file-approval`, which it never emits; the row now says `question` and
  `permission`.
- ~~Whether the Cursor SDK also loads `.cursor/mcp.json` itself when
  `settingSources` includes `project`.~~ Yes. In the pinned `@cursor/sdk`
  1.0.40 the MCP adapter is built with `includeProjectMcp:
  settingSources.includes("project")` and then loads
  `<project>/.cursor/mcp.json` beside the inline set. The bridge already
  avoids a duplicate: with project settings loaded, `cursorInlineMcpServers`
  passes only the backend-owned `orkestrator` and artifact servers inline.
  New tests in `mcp.test.ts` ("cursorInlineMcpServers") pin that.

## Assumptions and decisions

Decisions made on 2026-10-25 while working through the file.

1. **"Always allow" for Claude (item 1).** Options: (a) offer
   `permission-grant` amendments built from `canUseTool` `suggestions`, with
   a new list and revoke surface; (b) offer none. Chose (b). Claude's
   suggestions write rules into the user's Claude settings, which outlive the
   session and Orkestrator, and the constraint here forbids that without a
   revoke surface. Pros: no allow-once decision can widen permissions; no new
   surface to maintain. Cons: a user who wants a tool always allowed must
   use an `auto-approve` policy or edit Claude's settings. The Codex
   amendments that already ship are split into 0160.
2. **Question preview format (item 3).** Options: leave it unset (the SDK
   default, `markdown`, but the card dropped previews), set `markdown` and
   show it as plain monospace text, or set `html` and render it. Chose
   `markdown`, shown verbatim. Pros: matches the CLI's own monospace box;
   model-written text is never parsed as Markdown or HTML, so there is no new
   injection surface; explicit, so an SDK default change cannot surprise the
   card. Cons: Markdown emphasis in a preview shows as literal characters.
   Previews are bounded (4,096 characters each, 32,768 per request) and
   dropped rather than letting a question exceed the snapshot bound.
3. **Codex questions (item 13).** Options: run Orkestrator Plan turns in
   Codex's Plan collaboration mode, or turn on
   `default_mode_request_user_input` for watched sessions. Chose the feature
   flag, on every non-`pipeline` thread (the coordinator included, because it
   is a conversation with the user). Pros: every interactive turn can ask,
   not only Plan; one thread-scoped setting; proven on the pinned binary.
   Cons: Codex marks the feature as under development, so it may be renamed;
   the live test runs on every bump to catch that. Plan mode would have
   needed an experimental API and changes the model's instructions.
4. **Codex `on-request` in a container (item 8).** Options: run it as
   `untrusted` under `auto-approve` too, or describe it honestly. Chose the
   description. Under `auto-approve` the pick is the user's own narrowing,
   and the picker already offers Untrusted, so remapping would make two
   options identical. Pros: no behaviour change; the UI no longer misleads.
   Cons: the text describes Build turns; a Plan turn's read-only sandbox can
   still ask.
5. **Provider sandbox on agents without one (open question).** Options:
   refuse the session, as Cursor refuses `deny`, or run it and report the
   truth with a note. Chose to keep running and reporting. The policy comes
   from an environment override that applies to every agent in the
   environment; refusing would break Pi, Grok and OpenCode tabs in an
   environment whose override was meant for Claude or Codex. Cursor refuses
   `deny` because it cannot express that axis at all, which is different
   from an agent without a sandbox. Pros: mixed-agent environments keep
   working; Agent Info states exactly what runs. Cons: a user who never
   opens Agent Info may assume the sandbox applies.
6. **Pausing from the public API (item 11).** No `expectedRevision`: a pause
   answers nothing and keeps the request ID, and requiring the revision would
   make each pause refuse the next. No voice confirmation: a pause cannot
   approve anything and still ends at the bridge's limit. One action with
   `held`, not two, mirroring the backend command. The API refuses up front
   when the bridge reports the pause unavailable, so the error carries the
   reason and no provider call is made.
7. **Claude MCP sign-in without a live CLI (open question).** Options: keep
   reconnecting on a probe (the link reaches no one), refuse with a message,
   or build a separate MCP-management sign-in flow. Chose to refuse with a
   message pointing at the parked card. Pros: honest and small; the card
   route already works with a live CLI. Cons: one extra step (send a message
   first). A separate flow stays possible under
   [0039-mcp-management.md](../mcp/0039-mcp-management.md).
8. **Claude tmux pause (item 9).**
   - Who enforces it: a request file the hook script consumes, with the
     script writing the new timing back. The script stays the only owner of
     its deadline and nothing runs per tick; the backend polls up to 5 s for
     the change.
   - Old installs: detected by a `hold-v1` argument in the hook command
     rather than a script version, because Claude Code snapshots hook
     settings at start; the argument proves the running CLI also took the
     matching `timeout`. A CLI started before the upgrade stays unpausable
     until it restarts, and the card says so.
   - Hook timeout: two hold ceilings (48 h) with the script stopping 60 s
     before, so the first pause always gets its full day.
   - Command: `claude_tmux_hold_hook`, not `hold_native_agent_interaction`,
     because tmux prompts are not native interactions and every other tmux
     action is a `claude_tmux_*` command. The same `hook` frame is re-emitted
     with the new deadline, so older clients just deduplicate it.
9. **OpenCode auto-answer removal (item 5).** The provider-level
   `onInteractionObservation` hook and the tracker's provider-reported
   observation path were removed with the branch, because nothing else fed
   them. Leaving them would have kept a public method and a grace-period
   sweep that production can never reach.
10. **Read-only reporting (item 7).** Claude reports per turn (while a
    read-only turn runs); Cursor and Grok report while the session's
    `readOnly` flag is set, because that is when their agent is built under
    the read-only policy, until a later prompt clears it. A shared note
    explains the difference in Agent Info.
11. **Lifting Grok's turn cap (item 10).** Options: pause the turn clock,
    extend the turn deadline to the latest hold, or drop the turn timeout
    while anything is parked. Chose pausing, keeping the time the turn had
    left. Pros: the turn's budget is unchanged and a forgotten request is
    still cancelled within 24 h. Cons: a turn whose requests keep being
    re-held can run past 30 minutes of wall time.
12. **A resumed Grok countdown against the turn (item 10).** The turn runs at
    least as long as a resumed countdown, rather than capping the countdown
    at the turn deadline. Pro: the card never shows more time than Grok will
    give. Con: up to five extra minutes on the turn.
13. **Grok's question timeout (item 10).** Options: always force it to the
    ceiling, raise it only when nothing sets it, or leave it and publish what
    is configured. Chose raising only the default and honouring a value the
    user set, which the card then shows. Con: a user's short value still ends
    a pause early, as the card says.
14. **Grok project resources (item 12).** Options: ship a throwaway
    `GROK_HOME` (with `GROK_AUTH_PATH` for the login), write untrust entries
    into the user's trust store, or keep reporting the truth and wait for an
    upstream switch. Chose to wait: the first drops the user's own Grok
    configuration and session store and is unqualified, the second
    permanently changes the user's Grok settings. Pro: nothing breaks. Con:
    the host default still loads a trusted checkout's resources, which Agent
    Info states.

Decisions made on 2026-11-06 while working through tasks 2, 7 and 9.

### Task 9: drive the whole bridge, not the SDK with hand-written options (2026-11-06)

Task 9. Chose to run the real bridge's routes in a probe process (as the MCP sync and first-turn live tests do) instead of extending `conformance-execution-policy-live.test.ts`, which calls the SDK with options of its own. Pros: the sandbox block, permission mode and `canUseTool` are the ones the bridge sends, and "no approval card" is read from the bridge's own `/interactions`, which is what the tab shows. Cons: about 17 s per run, and the probe needs a clean process because the session-manager suites mock the SDK. The existing conformance test is kept: it also covers the unavailable-sandbox refusal.

### Task 9: route one request through the sandbox proxy

Task 9. Chose to send the unlisted request both directly and with `curl --noproxy ''`. The sandbox's `NO_PROXY` covers loopback, so a plain loopback request never reaches the proxy, where `strictAllowlist` is decided. A public domain would reach the proxy without the flag, but the ticket prefers a loopback server, and a public host makes the run depend on the network. The `networkAccess: "full"` controls show that the proxied request is reached, or asked about, once `strictAllowlist` is off. That makes the refusal evidence of the option, not of a broken route.

### Task 9: cover both answers to an ask-policy escape (2026-11-06)

Chose two separate outside-write turns with `dangerouslyDisableSandbox: true`,
one accepted and one declined through the real bridge interactions route.
Both assert that the file is absent before the approval is answered. This
closes the review's ask-policy coverage gap and proves both actual escape
after acceptance and no write after denial; checking the card alone would
not establish either outcome. The existing auto-approve cases still prove
that unattended requests cannot escape.

### Task 9: the CLI under test is the SDK's bundled binary

Task 9. Chose the CLI the SDK bundles, the one a bridge runs when `CLAUDE_CLI_PATH` is unset, over the managed toolchain under the real data directory, which test fixtures must not use. At SDK `0.3.314` it is `2.1.314`, the pinned toolchain version. The test fails if the two drift apart. `ORKESTRATOR_POLICY_CLAUDE_PATH` names another binary.

### Task 9: the Linux half reuses the macOS check (2026-11-10)

Task 9. Chose to lift the macOS-only gate of `claude-provider-sandbox.live.test.ts` and keep one check for both systems, rather than write a separate Linux test. The gate (`providerSandboxLiveGate`) runs on Linux only when the uncached `probeClaudeLinuxSandbox()` reports the sandbox available, because the node test preload pins the cached `claudeLinuxSandboxStatus()` to `available`, which would run the check on a host where the bridge then refuses every turn. Pros: the same 14 turns and controls prove the same two options on both systems, and an SDK bump re-runs both through one task. Cons: the platform differences live in a table (`PLATFORM_SANDBOX_EXPECTATIONS`) that a CLI change on one system has to update; `claude-provider-sandbox-live-gate.test.ts` pins the gate and the table in the default tier.

### Task 9: assert Linux's direct-loopback refusal rather than drop the control (2026-11-10)

Task 9. `control-direct-full` was a macOS control (full network reaches loopback directly). On Linux it is refused. Options were dropping the control on Linux, or asserting the refusal as the platform's behaviour. Chose to assert it: the SDK documents `allowLocalBinding` as macOS-only, so a later CLI that starts reaching loopback on Linux is a network-model change an upgrade should notice. `control-proxy-full` still shows that a full-network command reaches the server, so the restricted turns' refusals keep their meaning. Users are told through a note on the reported policy, added on 2026-11-11 by 7563 (retired); no production code changed for it here.

### Task 2: keep a skill written during a running turn as residual risk

Chose to record it rather than reload a running thread. The turn-boundary
case is already closed and tested; a reload mid-turn would abandon the turn,
because app-server takes `skills.config` only on start or resume.

### Task 2: trust the canary hooks by hash in the fixture

Codex 0.166.0 skips an untrusted project hook on its own, so a canary that
never ran would pass the pinned cases by accident. The fixture asks the
pinned binary's `hooks/list` for each hook's key and hash and records them the
way Codex's hook review does, which makes the control case prove the hooks
can run. `bypass_hook_trust` was not used: `hooks/list` still reports such
hooks as untrusted, so it would not show the trust state the test relies on.

### Task 2: fix the stale AGENTS.md assertion instead of the bridge

The AGENTS.md canary reaching a pinned thread is the documented
repository-instructions copy, not Codex loading the checkout. The test now
counts only Codex's own copy, and `upgrade-agents.md` names the file as a
Codex bump gate.

### Task 7: component browser suite rather than a `dev:test` profile

The checks run in the component browser suite against real bridge code with
provider fakes (the Claude SDK double, the fake `codex` app-server), like
`ClaudeInteractions.spec.ts` and `CodexHostRules.spec.ts`. A real-stack
profile would need a provider CLI pointed at a scripted model for Claude and
a working Orkestrator MCP server for the coordinator, and would prove no more
about the cards. Each spec host starts only when a test needs it; starting
all three in every worker timed out under the default worker count on a cold
fixture server.

### Task 7: the coordinator check runs in a coordinator bridge process

The fixture host sets `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`
as the launcher does, so the policy comes from process authority, not the
session request, and the read-only hook and allow list are the production
ones. The test SDK stubs MCP loading, so the host reports the Orkestrator
server as loaded; the address is never contacted.

### Task 8: container cells on fake engines (2026-11-06)

- **Engine.** Chose the bridges' own fake engines (Cursor's fake SDK, Pi's faux model) over real logins, as the ticket requires: no billed turns and no credentials in the container. Pros: repeatable on any Docker host, and the bridge, the backend launch, the token and the firewall are all real. Cons: a real Cursor SDK's tools and a real Pi provider are not exercised (their opt-in variants came later: 7040 (retired)).
- **How the fake gets into the container.** Chose to swap the image's bridge entry inside the disposable fixture container for the case, keeping the real file beside it and restoring it in `finally`. The other option was a test-only launch override in `start_<platform>_server`. Pros of the swap: production launch code is unchanged and nothing in it knows about the fake. Cons: the case writes to `/opt` as root in the fixture container. Cleanup leaves the page first, stops the bridge, restores the entry and stops again, because a mounted tab could restart the fake between the stop and the restore (seen on the first run).
- **Network probe.** Chose an off-allowlist URL (`example.com`) with GitHub as the allowed control, so a container with no network at all cannot pass as "refused".
- **Toolchain downloads on a host with Docker churn.** Electron downloads with Chromium's `net.fetch`, which aborts on every interface change. Two options were weighed. The first was more unattended retries in Electron for agent-test profiles: it is simple, but a burst of interface changes could still exhaust them. The second was to download in the `dev:test` launcher with Bun's `fetch`, which interface changes do not abort, through the same manager and hash checks. Chose the launcher download, keeping Electron's download as the fallback. Also chose to let `downloadArchive` retry a request Chromium aborted with `ERR_NETWORK_CHANGED` before any bytes arrived, so the desktop app gets the same help.
- **A refused first send in the Pi cell.** Chose to record the refusal and resend once, only when the projection proves the prompt never reached the session. Pros: a refusal leaves evidence in the results, and nothing can run twice. Cons: a refusal that a resend fixes no longer fails the case. That gap is recorded in [7042](7042-pi-container-cell-first-send-refused.md).

### Task 3: assert the kind after finding the card (2026-11-13)

- **Where the assertion sits.** Options: (a) narrow the set of kinds the
  case waits for to `command-approval`; (b) keep waiting for any approval
  kind and then require `command-approval` for the cases that name one.
  Chose (b). With (a), a Grok approval that still arrived as a generic
  `permission` would never be found, and the run would fail after five
  minutes as "never asked"; with (b) it fails at once, naming the kind it
  got. The cost is a second check beside the wait.
- **Which cases.** Only `grok-approval` names a kind. The prompt asks for one
  shell command, which Grok sends as an ACP `execute` call; the ACP bridge
  describes an `execute` call with a command as a command approval and falls
  back to a generic permission without one. Other providers' approval cases
  keep accepting any approval kind, as the ticket asked for Grok only.

## Related

- `0160-codex-saved-rules-list-and-revoke.md` (deleted 2026-11-06),
  `0161-codex-default-mode-question-activity.md` (split out on 2026-10-25,
  deleted 2026-11-06).
- [agent-engines.md](../../architecture/agent-engines.md#interaction-deadlines-and-pausing):
  the OpenCode abort and session-grant rules from todo 0162 (the interaction
  test gaps, split out on 2026-10-25 and retired on 2026-10-29).
- 0723 (retired; `git show dc90609bf:docs/todo/agent-engines/0723-orkestrator-permission-rules.md`), now
  [permission-rules.md](../../architecture/permission-rules.md)
  (Orkestrator-owned "always allow" rules, applied as allow-once; meets decision 1's
  list-and-revoke constraint without a provider rule).
- [0039-mcp-management.md](../mcp/0039-mcp-management.md) (MCP OAuth and `mcp-url` sign-in).
- [`coordinator-read-only-decisions.md`](../../architecture/coordinator-read-only-decisions.md)
  (coordinator safety tiers, `coordinator-providers.ts`; to-do 0026, retired 2026-11-11).
- [agent-accounts.md](../../architecture/agent-accounts.md#sign-in-readiness), to-do
  0003 (retired 2026-11-13) (provider sign-in and readiness).
- [0007-provider-sdk-adoption-backlog.md](0007-provider-sdk-adoption-backlog.md)
  (deferred Claude pending-permission re-arm and MCP permission provenance).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  for the Docker and provider runs.
- [agent-engines.md](../../architecture/agent-engines.md) "Execution policy".
- 7563 (retired 2026-11-11, `git show 498b68766:docs/todo/agent-engines/7563-claude-linux-sandbox-loopback-under-full-network.md`):
  task 9's Linux finding, a full-network provider sandbox does not reach
  loopback directly; done as the Agent Info note described in
  [agent-engines.md](../../architecture/agent-engines.md#execution-policy).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the live Grok runs from task 3, tasks 4, 5 and 6) moved there on 2026-11-10; filing the xAI request from task 1 is its "File the upstream reports" item, pointing at [`docs/upstream-issues/`](../../upstream-issues/0000-index.md).

## Replaces

- `docs/plans/sdk-coverage/04-interactions-elicitation-and-permissions.md`
- `docs/plans/sdk-coverage/12-execution-policy-and-host-container-parity.md`
  (deprecated overrides, Docker and host QA, the documentation drift)
- `docs/plans/sdk-coverage/01-quick-correctness-fixes.md` (done; its Cursor
  host-policy decision is now the execution policy)
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.5, §3.8; Codex §4.4, §4.9;
  OpenCode §5.7; Cursor §6.1; the "Approvals capability bit" and "Host versus
  container parity" cross-cutting notes)
