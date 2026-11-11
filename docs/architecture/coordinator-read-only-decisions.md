# Coordinator read-only adapters: decisions

Status: Living — the per-platform decisions behind the tiers in
[`coordinator.md`](coordinator.md#provider-qualification). Folded in from to-do
0026 (retired 2026-11-11; read it with
`git show 498b68766:docs/todo/coordinator-and-multi-review/0026-coordinator-read-only-adapters.md`).

A coordinator runs against the user's real checkout, so every platform it
offers must hold the same read-only outcome: creating a file, editing a file,
running a writing shell command and fetching a URL all fail, and Control MCP
discovery still works. The deny list is one shared policy
(`resolveNativeAgentExecutionPolicy(..., "coordinator")`). What differs is how
strongly each adapter holds it. [`coordinator.md`](coordinator.md) describes
what each platform does today; this file records why, with the options that
were weighed, so a later change can tell which facts a decision rests on.

The facts that move with a pinned version are re-checked on every bump:
[Re-check coordinator tier decisions](../development/upgrade-agents.md#re-check-coordinator-tier-decisions)
in the upgrade guide. The live runs these decisions still lack (Claude on
Windows, Claude on Linux with and without `bwrap`/`socat`, research-server
calls on Pi, Cursor and OpenCode, and a read-only re-run on all six) are on the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md),
cited as `0026 (retired)`.

## Rules for adapter work

- Do not cover a missing adapter half with prompt text. A platform joins the
  unified set only when its adapter holds the same contract as the others.
- New adapter work honours the policy on create, resume, config and every turn,
  and fails closed if a persisted session carries another policy id.
- Moving a platform to `enforced` needs everything in
  [Changing qualification](coordinator.md#changing-qualification), an entry in
  the `enforced` list in `coordinator-conformance.test.ts` (pinned to
  `claude`, `codex` and `pi`), and a live read-only run.
- An OS sandbox is not a write guard for the checkout unless it is told so.
  The Claude SDK sandbox's default write allowance includes the working
  directory. Any sandbox a coordinator relies on must deny the checkout
  explicitly, and the command filter must not assume a sandbox behind it.
- `delegation` is derived (`mcpClient && canInject`), not declared. The tier is
  about sandbox strength, not mail.

## Decisions

**D1. Is Claude offered on Windows at the default safety level?**

- Options: (a) keep it at `provider-configured` with the hook allowlist as the
  boundary; (b) drop it to `advisory`, off by default; (c) mark it unavailable
  on Windows.
- Chosen: (a). The hook is a bridge-owned allowlist of reading commands with a
  closed tool allowlist and `canUseTool` refusing the rest, the same kind of
  boundary as OpenCode's permission engine. `advisory` means only the agent's
  cooperation holds the boundary, which is not the case.
- Pros: Windows users keep a coordinator; the tier and reason say plainly that
  nothing outside the agent enforces it, and an `enforced`-only installation
  refuses it.
- Cons: a bypass of the command filter on Windows is a real write, with no OS
  layer behind it. D3 narrows that; the live Windows run is still owed.

**D2. How does the bridge learn whether the sandbox can start?**

- Options: (a) the backend's probe, passed at launch as process authority
  (`ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX`); (b) a second probe in the
  bridge; (c) always `failIfUnavailable: false`.
- Chosen: (a), absent or malformed reading as `required`. One probe decides
  both the tier the user sees and what the bridge requires, so they cannot
  disagree, and a request body cannot change it.
- Pros: fail-closed by default; an older launcher keeps the sandbox required;
  workers never receive the variable (the launcher clears an inherited one).
- Cons: the probe is a necessary condition only. Since to-do 0145
  (2026-10-26) it runs bubblewrap with a nested user namespace on Linux, and
  `unavailable` leaves the sandbox off.

**D3. Deny the checkout in the sandbox, and harden the command filter.**

- Options: (a) `filesystem.denyWrite` on the checkout plus a hardened hook;
  (b) only the hook; (c) only the sandbox setting.
- Chosen: (a). Live on macOS (2026-10-24), a coordinator turn ran
  `uniq in.txt out.txt` (admitted by the hook) and wrote `out.txt` into the
  checkout of an `enforced` Claude coordinator
  (`scripts/coordinator-probes/claude-sandbox-write-probe.mjs`). Denying the
  checkout closes that whatever the hook admits; the hook is the whole
  boundary where no sandbox starts, so it also refuses every writing form it
  can recognise (see `AGENTS.md`, "Coordinator shell allowlist"). Regression
  test: `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts`.
- Pros: two independent layers on macOS and Linux; the network-only refusals
  cost nothing, because sandboxed coordinator commands have no network anyway.
- Cons: the stricter filter refuses some reading forms (`/usr/bin/cat`, `gh`,
  clusters such as `date -Iseconds` or `yq -ojson`, awk options other than
  `-F` and `-v`). The refusal says why, and the work can be delegated.

**D4. Codex `sleep`.**

- Options: (a) argv0 deny for `sleep` and similar in the permission profile;
  (b) no deny, the Control MCP poll guard as the backstop.
- Chosen: (b). No Codex coordinator ran `sleep` in the 2026-10-18 live async
  and family runs (nor did Claude, OpenCode or Cursor), and mailbox polling is
  refused by `coordinatorPollGuard`.
- Pros: no new profile surface to keep in step with Codex bumps.
- Cons: a Codex coordinator that does sleep wastes a turn's time until the
  live suite catches it. Revisit if a live run shows it.

**D5. OpenCode's final tier.**

- Options: (a) `provider-configured` as final; (b) work towards `enforced` by
  disabling project MCP servers (for example `OPENCODE_DISABLE_PROJECT_CONFIG`).
- Chosen: (a). `enforced` claims the provider or the OS blocks a mutation
  whatever the agent does; OpenCode has no OS sandbox, so its permission
  engine stays the boundary even with project servers gone, and disabling
  project config on 1.x could drop providers or models a user configured per
  project.
- Pros: the tier tells the truth; nothing a user relies on changes.
- Cons: on 1.x, command-backed project MCP servers still start with a
  coordinator's OpenCode server, as in any OpenCode session on that checkout.

**D6. Cursor's final tier.**

- Options: (a) `provider-configured` as final; (b) wait for a verification
  probe before deciding.
- Chosen: (a). `@cursor/sdk` 1.0.40 has no approval callback
  (`LocalAgentOptions` has `sandboxOptions`, `autoReview` and `customTools`,
  whose calls bypass approval by design), so a denial cannot be verified from
  outside. The sandbox plus a closed tool allowlist is real configuration.
- Pros: no indefinite open item; the tier and reason say what is missing.
- Cons: re-open if Cursor ships an approval or tool-call callback.

**D7. Grok's tier.**

- Options: (a) stay `advisory`; (b) move to `provider-configured` now that the
  profile removes the mutation tools.
- Chosen: (a). xAI's hosted X search tools survive every switch, and tools
  that never ask are still not stopped. That is the definition of `advisory`.
- Pros: Grok stays opt-in at the default level.
- Cons: Grok users who want a coordinator must lower the safety level.

**D8. Grok search when research is on.**

- Options: (a) keep `--disable-web-search` (search off); (b) drop the flag and
  remove fetch alone with `GROK_WEB_FETCH=0` and a profile entry.
- Chosen: (a). Live on 1.0.67 (2026-10-24,
  `scripts/coordinator-probes/grok-web-tools-probe.mjs`), (b) still opened
  `https://example.com` through the hosted search's `open_page`, which neither
  the profile's `disallowedTools` nor `--disallowed-tools` removes.
  `--disable-web-search` removes `web_search`, `open_page`,
  `open_page_with_find` and `web_fetch`.
- Pros: the research setting's "never fetch" holds on Grok.
- Cons: Grok coordinators get no web search at all, and no research servers.

**D9. Readiness state for a failed Codex lock.**

- Options: (a) add a `NativeAgentReadiness` state now; (b) leave it until a
  Codex bump trips `assertHostedNetworkLock`.
- Chosen: (b). The check has never tripped, and the state would touch the
  protocol, the renderer and every provider for a case that has not happened.
- Pros: no speculative protocol change.
- Cons: if a bump trips it, the user sees a failed first turn (which names the
  cause) rather than a not-ready conversation.

**D10. How OpenCode allows research tools.**

- Options: (a) a `<name>_*` permission pattern; (b) exact ids from OpenCode's
  own tool listing; (c) exact ids built from the research server's own tool
  list, minus ids a longer-named project server could share.
- Chosen: (c) (`openCodeResearchToolIds`). OpenCode always loads the
  checkout's configuration, so a project server named `<name>_x` would fall
  under (a); (b) is not possible, because OpenCode 1.19.4 lists only built-in
  tools over HTTP.
- Pros: no pattern a checkout can grow into; registration replaces a project
  entry under the research name; a failure leaves the coordinator without that
  server rather than failing the launch.
- Cons: the backend lists each server's tools once at launch, so a tool added
  later is not allowed until the next launch; an OpenCode instance reload, or
  a backend restart beside a still-running server, leaves research tools
  denied until the conversation's agent restarts.

**D11. How Cursor hosts research tools.**

- Options: (a) inline HTTP `mcpServers`; (b) in-process custom tools.
- Chosen: (b) (`hostResearchCustomTools`). Cursor's SDK fails HTTP MCP calls
  closed on a sandboxed, approvals-deny attach, which is why Orkestrator's own
  tools are hosted the same way.
- Pros: works inside the coordinator sandbox; the bridge owns the connection
  and its bounds.
- Cons: tool names carry a `<name>__` prefix inside the SDK's
  `custom-user-tools` carrier, which the bridge unwraps for rows and inventory.

**D12. Pi research servers and name collisions.**

- Options: (a) research servers reserved, dropping a `mcp.json` entry of the
  same name; (b) let the user's entry win.
- Chosen: (a), and only under the coordinator's process authority. The
  read-only gate admits research tools by registered name, and a user entry
  under that name is usually a local program, which a coordinator must not run
  as if it were the remote server.
- Pros: the gate's exemption means exactly the launcher's servers.
- Cons: a user's own same-named server is unavailable to coordinators (it
  still works in ordinary Pi sessions).

Assumptions:

- The pinned Claude CLI's Windows sandbox stays off by default (a vendor
  feature flag, `tengu_nankeen_kestrel`, read from the 2.1.309 binary). If it
  turns on, `unavailable` already asks for the sandbox, so Windows gains it
  without a change, though it is still reported as `provider-configured`.
- OpenCode names an MCP tool `<server>_<tool>`, with characters other than
  letters, digits, `_` and `-` replaced by `_`, and checks its permission by
  that id.
- Research servers listed in settings answer an unauthenticated MCP
  `tools/list`, as Context7 does; one that does not is skipped.

## Codex refused cells

Under a `read-only` or `workspace-write` sandbox, Codex emits no item for a
rejected `apply_patch`, nor for a failing command whose output looks like a
sandbox denial (mapped on 0.162.1; still so on 0.164.0 and later, pinned by
`live-refused-calls.test.ts`). The model is told and usually says the call was
denied, so a Codex coordinator looked as if it claimed a denial it never
tried. `RefusedCellTail` (`bridges/codex-bridge/src/sessions/refused-cell-tail.ts`)
reads the turn's records from the rollout and shows such a code-mode cell as a
failed `exec` row. The choices:

- **The rollout, not raw events.** `experimentalRawEvents` streams the cell,
  but only `thread/start` accepts it: a thread resumed in a new app-server
  process, or a fork, never gets raw events, so every conversation that
  outlives an app restart would lose the rows again. Raw events would also
  need `experimentalApi` for the whole connection.
- **Poll, and order the turn's events behind a read.** `fs.watch` fired nothing
  on macOS for Codex's appends (same inode, growing size), so the tail polls
  every 200 ms while a turn runs. An event that opens a new model response, and
  `turn.completed`, wait for a rollout read so earlier cells are placed first.
  Only that thread waits; app-server's notification stream keeps being
  consumed. The queue is bounded; on overflow the bridge stops reading the
  rollout, applies the queued events and tells readers to reconcile.
- **Start at the size captured before `turn/start`,** not at end of file when
  `turn/started` is applied: a fast turn can write its cells before that. A
  turn that did not go through the prompt path (an inline review) reads a
  bounded window and keeps only records carrying its own turn id.
- **Which cells become rows.** Either no client tool item of the turn started
  while the cell ran, or its output carries "patch rejected", "Operation not
  permitted", "Permission denied" or "Read-only file system". Codex's own
  heuristic also matches "sandbox", "landlock", "seccomp" and "failed to write
  file", but ordinary output says those words, and a cell whose calls already
  have rows would gain a duplicate. Showing every cell, as a reload does, would
  show each nested command twice in the live view.
- **The row** is a completed `dynamic_tool_call` named `exec`, failed when the
  output reports a refusal or a failed script: the row a reload builds from the
  same rollout record, with the same id (the `call_id`).
- Only code-mode cells are read. A direct `apply_patch` or `exec_command` call
  from a model that does not run in code mode would still have no row.

## Live evidence so far

- Codex and Claude coordinators found Bun's latest version through web search
  and React's Context7 library ID through Context7 with the default research
  setting (2026-10-16); neither could open a fresh page.
- Claude read-only on macOS after D3: the hook refused `uniq in.txt out.txt`,
  and `mise run test:agent:coordinator --credential-source claude --scenario read-only`
  passed (2026-10-24, run `qa-coordinator-2026-10-24T00-36-14-146Z`).
- Claude's sandbox on Linux: see
  [Claude's sandbox on Linux](coordinator.md#claudes-sandbox-on-linux).
- The live suite's `research` scenario (added 2026-11-11) asks a coordinator,
  under the shipped default research setting, to resolve React's Context7
  library ID, and passes only on a transcript row attributed to the research
  server (`apps/desktop/scripts/dev/coordinator-live-research.ts`); Grok is
  skipped with D8's reason. It has not yet run against a real provider.
