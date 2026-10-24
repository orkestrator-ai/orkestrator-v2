# Slash-command qualification

Checked against `main` at `06297124` (2026-10-23).

Every slash-command executor was first qualified from installed SDK
declarations and source, then exercised through each integration's real
execution path with transport-level fakes. The live provider probes and the
inactive-environment browser scenario then ran on 2026-10-17, and Pi, Codex
disabled skills, the container paths, the mixed-version matrix and the
performance harness on 2026-10-23 (records below). This file collects the
evidence still needed before the feature can be called complete. Failures
found here become code items in
[0016-slash-command-catalogue.md](0016-slash-command-catalogue.md).

## Current state

- The per-provider support, unavailable-command and literal-suppression tables
  are in [`native-agent-commands.md`](../../architecture/native-agent-commands.md#provider-support),
  which now names the pin and date each provider was qualified live on.
- The composer is covered by component tests
  (`apps/web/src/components/chat/SlashCommandMenu.test.tsx`,
  `apps/web/src/hooks/useSlashCommandMenu.test.tsx`,
  `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx`,
  `apps/web/src/hooks/useNativeAgentSession.commands.test.tsx`) and, live, by
  `e2e/agent-testing/slash-command-inactive.spec.ts` (opt-in; see the record).
- `dev:test` runs on a macOS host with a display. The 2026-09-23 attempt on a
  headless Linux host failed with "Missing X server or $DISPLAY".

## Qualification record (2026-10-17)

Run on `main` at `31d0fb06` plus this branch's Claude fix, on macOS (Apple
Silicon), in the disposable profile `slashq-e47d` (`dev:test --fixture`, all
credential sources, all agent platforms). Every command lived in a disposable
local environment's worktree, created with the execution-policy override
`projectResources: true`. That is the supported way to load project commands
in a host session; without it Claude reads only user settings
(`native-agent-execution-policy.ts:76`). User-scope commands were written only
where the profile's home is isolated: Pi (`~/.pi/agent/prompts`) and Grok
(`~/.grok/skills`). Claude, Codex and OpenCode share the host's real
provider homes in an agent-test profile, so no file was written there; their
existing user rows were observed instead. Proof that a command ran is a
random nonce that exists only in the command file and comes back in the
reply, never a model's claim.

Pins (all equal to the toolchain manifest, `docker/Dockerfile` and the
package pins):

| Provider | Pin | Result |
| --- | --- | --- |
| Claude | Agent SDK 0.3.296 / CLI 2.1.296 | Passed, after the probe fix below |
| Codex | app-server 0.162.1 | Passed |
| OpenCode | SDK and server 1.19.0, model `opencode-go/deepseek-v4.1-flash` | Passed |
| Grok | build 1.0.52 / ACP SDK 1.8.0 | Passed for user skills; project skills not loaded (see "Needs verification") |
| Cursor | SDK 1.0.37 | Passed: still `unsupported` |
| Pi | SDK and CLI 1.2.0 | **Skipped**: no Pi credentials on the host |

Command counts as projected (provider rows plus Orkestrator's session
actions):

| Provider | Cold, before the first turn | After a turn | After the inventory change |
| --- | --- | --- | --- |
| Claude | 56, `stale` (probe), 1.5 s | 56, `ready` at the next 30 s TTL read | 57 |
| Codex | 14 (7 skills, 3 templates, 2 built-ins), `ready`, 6.6 s | 100 (86 plugin skills appear) | 103 |
| OpenCode | 6, `ready`, 3.4 s | 6 | 7, only after a server restart |
| Grok | 13, `ready` (push), 3.2 s | 33 | 34 |
| Cursor | 1 (`/steer`), `unsupported`, 0.4 s | — | — |
| Pi | 2 (session actions), `stale`: refresh `failed`, no signed-in provider | — | — |

Per provider:

- **Claude.**
  - A selected project template ran with `$ARGUMENTS` substituted; so did a
    typed spelling.
  - `/context` completed as a local-output row with no model turn (about 5 s).
  - `/compact` (the provider's own, which takes precedence over
    Orkestrator's) completed in about 17 s with a compaction row.
  - `/clear` is refused before dispatch whether selected, typed or literal.
  - **Probe vs live query:** both list the same 57 names (user skills and
    plugin commands included). The difference is availability: the live list
    marks `/color`, `/focus`, `/reload-plugins` and `/doctor`
    `requires-interactive-ui` from the init frame's
    `terminal_slash_commands`, which a probe never gets.
    Selecting `/focus` in a new tab answers "/focus isn't available here yet"
    as local output (code item 8 in the catalogue file, fixed 2026-10-17).
  - **Inventory change:** an idle TTL read serves the cached list. An explicit
    refresh answers `deferred`, and the new command appears at the first TTL
    read after the next turn.
  - **Restart:**
    - The backend serves the pre-restart `ready` list until its TTL expires
      (about 23 s), then the probe's `stale` list. Commands run afterwards.
    - An idle session the restarted bridge does not hold reads in-band
      `missing`, so the picker shows `unavailable` until an explicit refresh.
      The refresh restores it from one probe and leaves no Claude process
      running.
  - **Bug found and fixed in this branch:** the "zero-turn" probe was not
    zero-turn (see "Fixes" below).
- **Codex.**
  - A cold `skills/list` works before any thread is resumed.
  - Templates, structured skills (`$name` and the `/skill:name` alias) and the
    bridge-local `/help` (no model turn) ran.
  - A template with `` !`…` `` is listed `requires-shell-execution` and
    refused. A template named `help` is listed as `/prompts:help`
    `reserved-name`.
  - Two skills with the same name in different roots are both listed
    `ambiguous`.
  - An idle TTL read does not pick up new files. An explicit refresh answers
    `reloaded` and does.
  - The catalogue survives a bridge restart, and the added template and skill
    ran afterwards.
  - The first read after the app-server starts misses plugin skills while
    reporting `ready` (code item 9 in the catalogue file).
  - Disabled skills were not qualified: a project `.codex/config.toml`
    `[[skills.config]] enabled = false` is ignored, and the host
    `~/.codex/config.toml` is off limits (item 2 below).
- **OpenCode.**
  - `session.command` answers only after the whole turn: dispatch took
    5.6 s for a 5.6 s turn and 4.3 s for a 4.3 s turn.
  - The server still substitutes `$ARGUMENTS` before running a template's
    `` !`cmd` `` span: `printf 'ARG=%s' "$ARGUMENTS"` with argument `zeta` ran
    as `ARG=zeta`.
  - A command's own `model` wins over the tab's explicit selection (the reply
    came from `glm-5.3-flash` while the tab stayed on `deepseek-v4.1-flash`).
    That matches the documented order in `dispatchOpenCodeCommand`.
  - Typed `/exit` and `/themes` are refused as terminal commands, with
    nothing sent.
  - A refresh answered `reread`, and a command file added while the server
    ran appeared only after `opencode serve` restarted (code item 10 in the
    catalogue file). Fixed 2026-10-17: a refresh now reloads the directory's
    instance when it is idle, and defers to the next idle edge otherwise.
- **Grok.**
  - The list arrives by push before the first turn.
  - A user skill ran through `session/prompt`, and its slash text reached the
    agent unchanged (the user row is the typed text).
  - `/session-info` is local output with no model turn.
  - A skill added on disk was pushed while the session sat idle, within about
    20 s. A refresh answers `reread`.
  - After a bridge restart, the restored rows stay `stale` across reads, and
    nothing re-attaches the session. Selecting one then ran it: the dispatch
    attached the session (`session/load`, about 30 s), Grok re-sent
    `available_commands_update`, and the selection was revalidated against
    the live list. So Grok **does** re-send after `session/load`.
  - Project skills (`.agents/skills`) and a `.grok/commands` file in the
    worktree were not listed: Grok had not trusted the folder (see "Verified
    after the run").
- **Cursor 1.0.37.**
  - The catalogue is `unsupported` and refresh answers `unsupported`; only
    `/steer` is listed.
  - The SDK declarations still have no command discovery or invocation API,
    only ambient skills and rules.
- **Pi 1.2.0: skipped.**
  - The host has no Pi login (`~/.pi/agent/auth.json` is `{}`) and no
    provider API key in the environment.
  - A local Pi tab in an agent-test profile also gets no `auth.json` (Pi
    credentials only seed the model catalogue and container mounts).
  - Without a signed-in provider Pi does not create the agent session, so
    even credential-free extension commands could not be listed or run.

Inactive-environment browser scenario: `e2e/agent-testing/slash-command-inactive.spec.ts`
passed for Codex (100 s) and Claude (125 s) in one run against the profile
above:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=<profile> ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1 \
  ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS=codex,claude \
  mise run test:logged -- --name slash-inactive -- mise run test:agent:browser -- \
  e2e/agent-testing/slash-command-inactive.spec.ts
```

The spec checks the following:

- A selected command sent just before switching to another environment
  completes while inactive and runs once. That happens through an inventory
  change (one command added, one removed), a 10 s browser outage
  (`context.setOffline`), and a catalogue
  refresh.
- On return: the reply, the new and removed rows in the picker, and the
  composer controls (no Stop).
- A stale draft (Codex): a selected command whose file was removed while
  inactive is refused with "The selected command is no longer available",
  the draft is kept, and nothing is sent.
- The result and the new inventory after a hard reload, then again at
  390×844.
- A bridge restart right after Send, and another while the accepted command
  runs. The original run counted final replies and user rows from a transcript
  proven reloaded; those counts alone cannot detect an interrupted execution:
  - Codex: neither command ran (the turn failed, nothing parked).
  - Claude: the first dispatch parked, was retried under the same request id
    and still did not run. The second did not run. The session then ran
    another command normally.

On Claude the stale-draft step was skipped here: a removed command left Claude's
list only at its next turn. Since #1055 it runs (see "Verified after the run").

Not run: the scenario on a container environment (item 1 below), with a
backend restart (a `dev:test` profile cannot restart its backend alone), and
on OpenCode, Grok or Pi (the spec supports Codex and Claude). Whether a refresh
keeps an idle session attached was checked by hand only: Claude (no CLI left
under the bridge, list stays `missing` until a refresh) and Grok (list stays
`stale`, so no `session/load`).

Correction (2026-10-18): `context.setOffline` does not drop an open event
stream (found while qualifying MCP apply, see
[0039-mcp-management.md](../mcp/0039-mcp-management.md)), so this outage never forced stream
reconciliation; it only failed the requests made during it. Follow-up 2 below.

### Review follow-up (2026-10-17)

The restart scenario now appends a durable execution marker as the command's
first action. The running-turn restart waits for exactly one marker and checks
that the turn is still running before stopping the bridge. Both restart cases
replay the captured browser submission with its original request ID, whether
or not reconciliation parked it. The first case permits zero or one execution;
the running-turn case requires exactly one, including after retry. Final reply
counts remain separate: an interrupted turn can execute without a final reply.

The opt-in scenario ran again in the disposable fixture profile
`qa-slash-review-1017`, with Codex and Claude credentials and only those two
platforms enabled: **2 passed, 0 skipped** (265 s). Both providers retained
exactly one execution marker through the running-turn restart and same-ID
retry. Codex also exercised stale-draft refusal; Claude's stale-draft step
retains its documented limitation above. The JSON report is
`output/agent-testing/qa-slash-review-1017/browser/results.json`.

The transient Claude rewind now awaits the SDK Query's `return()` cleanup
after `close()`. A bounded shutdown wait returns a retryable conflict while
retaining the rewind fence; confirmed late cleanup releases it. Focused
regressions cover delayed, timed-out and rejected cleanup, prompt and rewind
admission during shutdown, and admission after confirmed shutdown. Model
catalogue, idle MCP action and plan-usage tests also assert that their probe
input never yields a user message.

A repeat exposed a cold-discovery bug before Claude's first send, reproduced
with Claude alone. The full projection held the project commands, but the
progressive discovery response retained an earlier session-action-only value
beside the newer catalogue state. Discovery now takes command rows and state
from the same authoritative catalogue snapshot. A backend regression holds a
cold provider read beyond its initial budget and keeps the clock fixed, proving
that the completed rows reach the browser without waiting for cache expiry.

With that fix, Codex passed the combined live run. Claude's initial turn then
failed with an SDK result diagnostic; the unchanged Claude-only owning file
passed on rerun (one passed, zero skipped, 87.3 s), including the inactive and
restart checks. This intermittent provider failure is recorded as
[0273](../../tests/flaky-tests/native-agents-and-transcripts/0273-claude-live-slash-provider-result.md), with the
failed combined command and evidence. Both providers therefore passed against
the final code; the JSON report above now contains the final Claude-only run.

Validation: the four focused Claude suites, the backend progressive,
projection and command suites, `format:check`, `lint` and `typecheck` passed.
The final `mise run test` passed the workspace, all five bridges and
Codex protocol groups. Its only failure was the existing
`tests/unit/flaky-tests-index.test.ts`: record
`docs/tests/flaky-tests/environments-and-containers/0265-command-fixture-hooks-aggregate-timeout.md` lacks
the required ID/status metadata in HEAD. The unchanged owning test also
failed alone, so this is a deterministic baseline failure, not a new flake.
Aggregate evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.9lkJ9D/summary.json`.
Validation covers local browser flows; Docker, Electron and iOS scenario suites
were outside this change.
The disposable profile was stopped and reset; no live launcher remains.

### Fixes from the run

- **Claude control queries ran turns.** Agent SDK 0.3.296 passes
  `--max-turns` only when the value is truthy, so `maxTurns: 0` was dropped,
  and every `prompt: ""` control query sent an empty user message that started
  a real turn.
  - The slash-command probe, model, account and MCP reads each left an empty
    session file under the user's `~/.claude/projects`.
  - A probe whose stream was read ran three model calls and two Bash tool
    calls.
  - A file rewind of an idle session appended an empty user message and a
    model reply to the user's own conversation.

  `controlOnlyQuery` (`bridges/claude-bridge/src/services/control-only-query.ts`)
  sends no message at all, and every metadata read and the transient rewind
  query use it. Checked live: a cold probe still lists 57 rows, account and
  model reads work, a dry-run rewind answers `canRewind: true`, and none of
  them writes a user or assistant row.

### Found outside slash commands

- Fresh installs: the default Codex model `gpt-5.4` is not offered to a
  ChatGPT login, the picker shows another model, and every turn fails. Fixed
  on `fix/codex-stored-model-mismatch`; see "Constraints and rationale" in
  [0004-composer-model-parameters.md](../agent-engines/0004-composer-model-parameters.md).
- A dev profile's backend reports the Electron version, which raises a
  version reminder over the composer's Send button
  ([0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md),
  code item 3).

### Verified after the run (2026-10-17)

Both "Needs verification" items from the run were real and are fixed.

**Grok skipped project commands in every Orkestrator environment by default.**
Grok gates a git checkout's AGENTS.md, skills, `.grok/commands`, hooks,
project MCP and LSP servers and project permission rules behind folder trust
(`$GROK_HOME/trusted_folders.toml`), and skips them without saying so. Headless
`grok agent stdio` never asks: over ACP it sent no `x.ai/folder_trust/request`.
`.grok/commands/*.md` is a Grok convention (legacy flat commands, listed as
skills). Evidence from the pinned 1.0.52 binary, in an isolated `GROK_HOME`:

- `grok inspect` in a git repo holding AGENTS.md, a `.grok/commands` file and
  two project skills: "Project trusted: no", no instructions, no skills. A
  grant for the repo, or `GROK_FOLDER_TRUST=0`, loads all four.
- A grant on a non-git parent does not cover a repository below it. A git
  worktree of a trusted repository is trusted. So a host worktree loads only
  when the user trusted its main checkout in Grok. A container's `/workspace`
  never matches the host paths in the staged trust store.
- A folder outside git, or a repository holding nothing the gate holds back
  (a `.grok/config.toml` setting only `model`), reports trusted. That is why
  the execution-policy conformance runner, whose fixture was not a git
  repository, saw project resources load.
- Live ACP session, signed in from an owner-only `auth.json` snapshot: the
  untrusted repository listed none of its three project rows; with
  `GROK_FOLDER_TRUST=0` and `agent --no-leader` it listed
  `probe-grok-cmd`, `probe-grok-skill` and `probe-agents-skill`, and wrote no
  trust store.

Fix: the ACP bridge launches Grok with `GROK_FOLDER_TRUST=0` and
`agent --no-leader` when the session's policy turns project resources on
(`PROJECT_TRUST` and `providerEnv` in `bridges/acp-bridge/src/acp-provider-config.ts`,
used by `AcpProcess`). Containers do by default, and so does a host
environment with the override. The conformance runner now uses a git fixture
with instructions and a command, and launches `grok inspect` with the bridge's
environment. Without the fix it fails all eight project-resources-on shapes.

**Claude told the user nothing when a restart lost a command.** The bridge
writes a prompt's request id to `dispatchedRequestIds` on disk before the turn
starts. After a restart, a same-id retry found the id there and answered 200
`already-processed` (`routes/session.ts`). The backend read any 2xx as
accepted. The web tab then removed the recovery card, the user's bubble and
the draft, with no notice. So "Retry send" looked like it delivered a command
that never ran. ACP, Cursor and Pi already refused such an id with 410
"outcome is unknown after a bridge restart".

Fix:

- The Claude bridge refuses a claimed id it restored from disk without an
  outcome (`restoredDispatchedRequestIds`, set on restore after a restart or a
  same-process tab close) with 410 and `kind: "dispatch-outcome-lost"`. ACP,
  Cursor and Pi add the same kind.
- The backend raises `PromptRejectedError` with `requestIdRetired`
  (`assertPromptOutcomeKnown`), clears the parked record even on
  a retry, and answers `rejected` with `requestIdRetired: true` and "Claude Code
  could not confirm this message, so it may not have run. Check the
  conversation and send it again if it did not."
- The tab shows that message, keeps the text and drops the id, so Send runs it
  under a new id. The warning is stored on the draft, so it survives the tab
  unmounting while the retry is in flight.
- A queued prompt refused this way gets a fresh dispatch id (its row id stays),
  so the queue's Retry can deliver it.

Live, in disposable profile `qa-slash-retired-a77b` (Claude only):
`slash-command-inactive.spec.ts` passed (1 passed, 100 s). The restart right
after Send parked, and the same-id retry returned `rejected (retired)` with the
message. The running-turn restart still executed exactly once.

The same run found the spec's Claude refresh expectation out of date. Since
#1055 keeps the CLI warm, Claude's refresh answers `reloaded`, so the spec now
treats Claude like Codex. That also runs Claude's stale-draft check, which
passed.

## Qualification record (2026-10-23)

Run on `main` at `06297124` plus this branch, on macOS (Apple M5 Pro), Bun
1.4.2. The pins are unchanged from the 2026-10-17 record.

### Pi 1.2.0, live (item 2)

`scripts/slash-probes/pi-commands-probe.mjs` starts the real Pi bridge with a
disposable agent directory, session directory, bridge state and git
repository, and shares only the host's `auth.json` by path
(`PI_BRIDGE_AUTH_FILE`, never a copy: the host login is OAuth with a rotating
refresh token). Every command file lives in the disposable repository's `.pi/`.
Proof is a random nonce in the command file or a marker file the extension
writes. Model `openai/gpt-5.6-luna` (`openai/gpt-5.5` is refused for this
ChatGPT login). The final run:

| Check | Result |
| --- | --- |
| Discovery | Unattached session: `stale`, no rows. After `attach` (0.2 s): `ready`, 8 rows (3 templates, 3 extension commands, `/steer`, `/compact`), read in 2 ms |
| Extension-before-template precedence | `/probe-shadow` (a template and an extension command) listed once, as the extension; selecting it ran the extension, and the template never reached the model |
| Headless extension completion | Selected `/probe-ext alpha beta` returned 202, ran with its arguments and finished in 7 ms with no model turn; its `sendMessage` output reached the transcript |
| Extension that asks the user | `ctx.hasUI` is `false`, and `ctx.ui.confirm` answers `false` at once; nothing blocks |
| Template with arguments | One model turn (3.6 s); the reply carried the nonce with `zeta` substituted |
| Literal opt-out | In a fresh session with tool calls denied: `/probe-ext literal-arg` and `/probe-tpl omega` sent with `allowProviderCommands: false` ran neither the extension nor the template, and each was an ordinary model turn. Control: the same typed text, interpreted, expanded |
| `reload()` mid-turn | Refresh during a running template turn answered `deferred`, the list read `stale`, and the turn completed. A template added on disk during the turn was listed after it (`ready`) |
| Idle refresh | `reloaded`; a template deleted on disk left the list |
| Stale selection | Selecting the deleted template answered 422 `command-unavailable`; nothing was sent |

`reload()` is still unsafe mid-turn in SDK 1.2.0: it fires `session_shutdown`,
invalidates the extension runner and resets the API providers with no guard of
its own, and Pi's terminal still refuses `/reload` while streaming
(`interactive-mode.js`). So the bridge keeps deferring. An earlier attempt with
tools allowed looked like a literal-opt-out failure: the model read `.pi/` with
`bash` and imitated both commands (it even wrote the extension's marker file).
Hence tools are denied in the literal step.

### Codex disabled skills (item 2)

`scripts/slash-probes/codex-disabled-skills-probe.mjs` runs the pinned
`codex app-server` 0.162.1 with a disposable `CODEX_HOME` and git repository
(no sign-in needed) and calls `skills/list`:

| Disabled by | Skill scope | `enabled` |
| --- | --- | --- |
| `[[skills.config]] path = … enabled = false` in `$CODEX_HOME/config.toml` | user | `false` |
| The same, naming a repository skill | repo | `false` |
| The same entry in the repository's `.codex/config.toml` | repo | `true` (ignored, also with the repository trusted, `CODEX_PROBE_TRUST_PROJECT=1`) |
| Not disabled | user and repo | `true` |

The bridge lists an `enabled: false` skill unavailable with reason `disabled`
(`skillUnavailability` in `bridges/codex-bridge/src/commands/skill-inventory.ts`,
pinned by `codex-command-catalogue.test.ts`). So disabled skills are qualified
for the user `config.toml`, the only place 0.162.1 honours.

### Containers (item 1)

- `slash-command-inactive.spec.ts` takes
  `ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT=local|container` (default `local`).
  The container variant creates a `containerized` environment with no
  `projectResources` override (the container default is what is qualified),
  writes command files and reads the execution marker in `/workspace` through
  `docker exec`, and restarts the container's bridge. No step is skipped. It
  needs a profile started with `--fixture-environments local,container`
  (`docs/development/agent-testing.md`).
- Path resolution, from code, with the tests that pin it. In a container every
  bridge and `opencode serve` run as `node` in `/workspace`, with no
  `CODEX_HOME`, `GROK_HOME` or `CLAUDE_CONFIG_DIR` override:

  | Provider | Where discovery resolves | Pinned by |
  | --- | --- | --- |
  | Claude | `claudeWorkspaceCwd()` (`CWD`, else the process cwd, `claude-query-config.ts`); the container start runs `cd /workspace`; project settings and plugins load only when `projectResources` is not false | new `claude-query-config.discovery.test.ts`; Claude container start test |
  | Codex | Templates in `<cwd>/.codex/prompts` and `$CODEX_HOME/prompts`; `skills/list` with `cwds: [cwd]`; the container exports `CWD=/workspace` | `rollout.test.ts`, `codex-command-catalogue.test.ts`; Codex container start test |
  | OpenCode | `command.list` with no `directory` for a container connection, so the server's own cwd (`cd /workspace` before `opencode serve`) | `native-agent-service-provider.test.ts`; OpenCode container start test |
  | Grok | `CWD` for the child and `session/new`; `$HOME/.grok`; folder trust off because containers load project resources by default | `acp-provider-config.test.ts`, `native-agent-execution-policy.test.ts`; Grok container start test |
  | Pi | `CWD=/workspace`, `PI_AGENT_DIR=/home/node/.pi/agent` | `runtime.test.ts`; Pi container start test |
  | Cursor | Unsupported | `cursor-bridge/src/http.test.ts` |

  The container start assertions are in
  `apps/backend/tests/commands-registry-servers.test.ts`. The backend never
  reads `.claude/commands`, `.codex/prompts` or `.grok/commands`; it only asks
  the bridge over HTTP. The renderer never receives a path: the protocol
  rebuilds each row from an allowlist (`agent-command-catalogue.test.ts`).
- Found on the way, not changed: host `~/.claude/skills` and `~/.grok/commands`
  are not staged into containers (`portable-inputs.ts`), so those user rows are
  missing in a container. That is what is listed, not where it resolves.

### Mixed-version matrix (item 3)

Transport-level fakes, in `mixed-version:` describe blocks, against the shapes
before #827 (`ff4026b4e^`, the version 1 catalogue; first released in
v2.21.0). Correction to the earlier premise: inside that window the old bridges
did not 404 on the session route. They all served `{ commands: [...] }` without
`catalogueVersion`. A 404 there comes only from bridges before #599 or from an
old Codex bridge asked about a session it does not hold. Both are covered.

- **New backend, old bridge** (`apps/backend/src/core/http-bridge-commands.test.ts`,
  all five bridges): pre-#827 rows read as non-enhanced `legacy:` rows that run
  as typed text, and a guessed enhanced id is refused with nothing sent; a 404
  falls back per read (never stickily) to the agent's legacy route, and ACP,
  which has none, reads `unavailable`; old Claude `"/name - description"`
  strings keep only bare names, so no built-in row survives; a version 1 body
  without its optional fields stays enhanced; an unknown `catalogueVersion`
  degrades to display rows; a malformed body is `unavailable` and keeps any
  held list as `stale`; a snapshot without `commandRevision` triggers nothing.
- **Old backend, new bridge** (each bridge's route tests): the legacy routes,
  session catalogue, snapshot and a prompt body without command flags are
  still readable; `commandRevision` is additive; ACP still has no legacy route.
- **Renderer and backend** (`commands-validation.test.ts`,
  `useNativeAgentSession.commands.test.tsx`, `workflows.commands.test.ts`,
  `useSlashCommandMenu.test.tsx`, `SlashCommandMenu.test.tsx`,
  `native-command-submission.test.ts`): an older renderer's dispatch without
  `command`; extra fields ignored and an unknown intent kind refused; old
  projections with display-only rows or no commands section; unknown fields
  carried along; a picker with no rows, id-less rows or unknown states degrades
  without errors.
- **Defects fixed:**
  - An availability state a backend does not know (a newer bridge's) was
    dropped and the command ran. `normalizeAvailability`
    (`packages/protocol/src/agent-command-catalogue.ts`) now makes it
    unavailable with reason `unsupported`.
  - The Claude branch of the sync-v1 snapshot dropped `commandRevision`
    (`http-bridge-provider.ts`), so those projections never re-read on
    `commands_changed`.
- **Limits, recorded in tests rather than changed:** a sync-v1 delta with a
  field outside `PROJECTION_FIELD_SET` is refused whole (current renderers read
  sync-v1 only as forced snapshots, which accept unknown fields; `policy` has
  been missing from the set since #604); an unknown discovery availability
  word fails the whole discovery read; a non-JSON or oversized catalogue body
  reports `provider-error`, never `malformed` or `too-large`.

### Performance (item 4)

`bun scripts/benchmark-slash-command-catalogue.ts` (`--json`, `--quick`) reads
through the real `HttpBridgeCatalogAdapter`, the cache and
`NativeAgentService.getProjection` against an in-process fake bridge serving
seeded synthetic inventories. No network, no provider. Three runs on Apple M5
Pro, Bun 1.4.2 (200 cold and 5,000 warm samples, 40 projection samples,
200 rounds of 21 keystrokes). Times in ms, ranges over the three runs:

| Inventory (wire bytes) | Cache cold p50 / p95 | Cache warm p50 / p95 | Projection cold p50 / p95 | Projection warm p50 / p95 | Provider reads (cold / warm) | Filter per keystroke p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 10 rows (3,238) | 0.04 / 0.09–0.19 | 0 / ≤0.001 | 0.70–1.04 / 1.6–2.7 | 0.26–0.31 / 0.5–1.0 | 1 / 0 | 0.002 / 0.006 |
| 100 rows (33,081) | 0.19–0.23 / 0.6–9.1 | 0 / ≤0.001 | 0.96–1.22 / 1.5–2.1 | 0.32–0.35 / 0.54–0.59 | 1 / 0 | 0.023 / 0.034 |
| 1,000 rows, cut to 512 (324,556) | 1.28–1.42 / 6.2–40 | 0 / ≤0.001 | 2.41–2.61 / 5.4–86 | 0.63–0.64 / 0.86–1.3 | 1 / 0 | 0.12 / 0.21–1.04 |
| 512 rows at the wire maximum (523,798) | 1.72–1.81 / 7.1–30 | 0 / ≤0.001 | 2.58–2.88 / 4.2–34 | 0.79–0.82 / 1.2–15 | 1 / 0 | 0.32–0.33 / 0.58–2.7 |

- **Budget.** 256 keys filled with 100-row inventories keep 254 entries
  (16,761,206 bytes, 2 evictions); with wire-maximum inventories, 16 entries
  (16,758,768 bytes, 240 evictions). No insert ever exceeded 16 MiB, the
  counted bytes match an independent recount, and the heap delta is 1.01–1.05×
  the counted bytes. The cache charges about twice the wire size per entry
  (the rows plus the change-detection signature).
- **Provider reads.** Cold read 1, warm read 0, warm dispatch read 0, forced
  dispatch read 1, expired read 1 (served from cache, re-read in the
  background), refresh 1 reload plus 1 read. Against an old bridge each read
  costs one extra request (the session-route 404, then the global route).
  `ensureSession` makes no provider read, the first projection one, later ones
  none.
- **Coalescing.** 50 concurrent cold reads, dispatch reads, a mix, or expired
  reads of one key cost one provider read. 100 cold reads across keys never run
  more than 4 provider reads at once; 68 are admitted (4 running, 64 queued) and
  32 are refused at once as `unavailable` (`provider-error`, 5 s backoff).
- **Defect found and fixed: concurrent refreshes.** 50 concurrent refreshes of
  one key cost 50 reloads and 50 reads, and 49 callers got `failed` although
  the provider answered: each refresh's forced re-read invalidated the one
  before it, and a late failure could overwrite the winner's `lastRefresh`.
  `NativeAgentCommandCatalogueCache.refresh` now coalesces per key into one
  running and one queued refresh. Measured after the fix: 2 reloads, 2 reads,
  all 50 `reloaded`.
- **Picker.** Typing 20 characters after `/` over 512 rows makes no projection
  fetch, catalogue refresh or file-tree call
  (`AgentNativeTab.commands.test.tsx`); a deliberate refresh-per-keystroke
  change failed it with 20 calls.
- Regression tests (counts and bytes, never timing):
  `apps/backend/src/core/native-agent-command-catalogue-scale.test.ts`.

### Follow-ups

**Lost Claude dispatch settles without a click (follow-up 1).**

- `GET /session/:id/dispatch` has a third in-band answer, `lost`
  (`BridgePromptDispatchStatus` in `packages/protocol/src/native-agent.ts`),
  given exactly where the prompt route refuses the id with 410
  `dispatch-outcome-lost`. `dispatched` still wins.
  - Claude: dispatch state `new` and the id in `restoredDispatchedRequestIds`,
    unless the persisted idle-`/steer` reply row shows it was a local answer.
    A session the restarted bridge has not loaded yet is answered from its
    preferences file, without registering, touching or hydrating it (an
    unreadable file answers `unknown`); otherwise an inactive environment
    would keep answering `unknown`.
  - ACP, Cursor and Pi: an `ambiguous` journal entry that is not a local reply
    (and, on Cursor, not this process's own failed send, which a retry may
    still deliver).
  - Older bridges never send `lost`, so they behave as before.
- The backend maps `lost` to `ProviderDispatchStatus` `"lost"`. Its
  reconciliation (`settleAmbiguousDispatch`, now `"confirmed" | "retired"`)
  clears the parked record without adding the id to `dispatchedRequestIds`, and
  stores `retiredDispatch: { requestId, retiredAt }` on the session
  (`retireNativeAgentDispatch`). The next retirement replaces it, the next
  accepted dispatch clears it, and it is ignored after 24 h
  (`NATIVE_AGENT_RETIRED_DISPATCH_TTL_MS`). A send whose own acknowledgement
  was lost and reconciles as `lost` is answered `rejected` with
  `requestIdRetired` at once.
- The projection and session-state view carry `retiredDispatch` with the
  message (`dispatchOutcomeLostMessage`, now also used by
  `assertPromptOutcomeKnown`), plus a `warning` notice
  (`dispatch-outcome-lost:<id>`) so an older renderer still shows it.
- The tab, also on a later mount, releases the draft's id when it still holds
  the retired one, keeps the text, clears the optimistic bubble and shows the
  message; the notice's toast is then suppressed. A queued prompt never parks,
  so the queue path needed no change.
- Tests: Claude `routes/session.test.ts` and `session-manager-lifecycle.test.ts`;
  ACP, Cursor and Pi route tests (four assertions moved from `unknown` to
  `lost`); backend `native-agent-service-dispatch.test.ts`,
  `native-agent-retired-dispatch.test.ts`, `storage-native-agent-sessions.test.ts`,
  `http-bridge-provider.test.ts`; web `AgentNativeTab.test.tsx` and
  `useNativeAgentSession.progressive.test.tsx`. Proved live on a host worktree in the Multi Review round below.
- Skew: an older renderer's sync-v1 delta check refuses the unknown
  `retiredDispatch` field, as it does every earlier additive field; full
  snapshots and the progressive view accept it.

**Outage drops the stream (follow-up 2).** The scenario's 10 s outage now
calls `context.setOffline(true)` and then `window.stop()`, and waits for the
page to log the event-stream disconnect. On return it requires a new answered
(2xx) response on the main event stream, which nothing can produce while
offline, so it proves a reconnect. The helper is shared with
`mcp-apply-inactive.spec.ts` (`e2e/agent-testing/event-stream-outage.ts`),
whose own check counted requests and is now the stricter response check too.

### Live browser runs (2026-10-23)

Disposable profile `qa-slash-0015` (`--fixture --fixture-environments
local,container --credential-source codex --credential-source claude
--agent-platforms codex,claude`), this branch's code, the container image built
from it (`orkestrator-v2:dev-182ff15b4e1f`):

| Run | Environment | Providers | Result |
| --- | --- | --- | --- |
| `slash-inactive-local` | host worktree | Codex, Claude | **2 passed, 0 skipped** (Codex 136 s, Claude 113 s), with the outage now dropping the stream and the reconnect asserted |
| `slash-inactive-container` | container | Codex, Claude | 2 failed at the first selection: the picker never opened (host load average about 70 from other worktrees). [0710](../../tests/flaky-tests/native-agents-and-transcripts/0710-container-slash-picker-closed-after-load.md) |
| `slash-inactive-container2` | container | Codex | Failed at the stale-draft step: the refusal took 5.7 s, past Playwright's 5 s default. The assertion now waits 30 s, like its neighbours |
| `slash-inactive-container3` | container | Codex, Claude | **Codex passed every step** (193 s, 0 skipped). Claude passed the first four steps, including the stale draft, then hit the picker symptom again after the narrow-viewport reload |
| `slash-inactive-container4` | container | Claude | **Passed every step** (284 s, 0 skipped) |
| `slash-claude-local-retired` | host worktree | Claude | Failed: the restart right after Send parked the dispatch, and the same-id retry came back `unknown (HTTP 500)`. The restarted bridge waited out the killed process's preference lock ([0059](../agent-engines/0059-claude-preference-lock-after-restart.md)). The spec retried once only, so the card stayed |
| `slash-claude-container-retired` | container | Claude | Failed: the 0710 picker symptom after the hard reload |
| `slash-claude-local-r2` | host worktree | Claude | **Passed** (101 s, 0 skipped), after the spec learned to retry again on `unknown` |
| `slash-claude-container-r2` | container | Claude | **Passed** (209 s, 0 skipped) |

So both providers are qualified in a container: a selected project command
written into `/workspace` was listed by the provider inside the container, ran
while the environment was inactive, survived the stream outage, the inventory
change, a refresh, a reload, a narrow viewport, and both bridge restarts
without running twice; a stale selection was refused and kept. The picker
symptom (3 of 7 container runs) is recorded as flake 0710 with its evidence;
it was not hidden with a retry or a longer wait.

Spec changes made during these runs:

- The stale-draft refusal waits 30 s instead of Playwright's 5 s default
  (diagnosed: the dispatch revalidates against the bridge, 5.7 s under load).
- After a restart, a same-id retry that answers `unknown` is retried again, up
  to four times, as a user would press Retry again; at-most-once is still
  asserted. The cause of the `unknown` is todo 0059.
- The restart steps annotate `retired-without-retry` when a parked dispatch is
  settled as lost by reconciliation (follow-up 1). None of the passing runs
  parked a dispatch at all (the restart came after the turn's first reply);
  the Multi Review round below added a step that stages the lost
  acknowledgement and proved the path live.

### Multi Review round (2026-10-23)

Multi Review returned two findings (one P1, one P2) and five test-coverage
gaps; a Fix session applied them in `35dba0957`:

- **P1, picker dismissal.** A mousedown inside the composer's own
  contenteditable counted as "outside" and closed the menu, and an Escape
  dismissal stuck to that exact text for good, so retyping the same token
  never reopened it. The menu now ignores clicks in the composer that owns it
  (`aria-controls`), and a dismissal ends when the token is cleared or
  completed (`useSlashCommandMenu.ts`, `SlashCommandMenu.tsx`).
- **P2, duplicate lost-dispatch warning.** A send whose own response said
  `requestIdRetired` showed the inline error and then a toast for the same
  notice when the projection caught up. The tab now dismisses that notice as
  soon as it releases the id, including before the notice arrives.
- **Coverage gaps:** retired dispatch on the agent-mail path stays unknown and
  fails closed; a third refresh arriving during the queued refresh gets its
  own reload; a restarted Claude bridge answers a cold `/dispatch` from disk
  without registering the session; menu click handling; the duplicate toast;
  and a live step in `slash-command-inactive.spec.ts` that stages a lost
  acknowledgement (`slash-command-lost-ack.ts` erases only the backend's
  acknowledgement and parks the record) around a real bridge restart.

Checked: every fix and test above; nothing rejected. Two further spec changes
were made here: the new first picker step waits 30 s like every other picker
wait (it used Playwright's 5 s default), and the merge with `main`.

Live, profile `qa-slash-0015r`, after the merge (host load average 60 to 72
from other worktrees):

| Run | Environment | Providers | Result |
| --- | --- | --- | --- |
| `slash-review-local` | host worktree | Codex, Claude | **2 passed, 0 skipped** (147 s, 172 s), including the new picker step and, for Claude, the lost-acknowledgement step: the parked dispatch was retired by reconciliation with no Retry, the draft kept its text under no request id, the message showed inline with no toast and no Retry button, and the resend under a new id ran exactly once more |
| `slash-review-container` | container | Codex, Claude | Both failed at the new picker step's 5 s wait |
| `slash-review-container2` | container | Codex, Claude | Picker step passed (14 s, 28 s) and the inactive completion passed; both failed when the returned tab's picker still lacked the refreshed row after 5 s. Flake 0710 holds the evidence |

So the click-free lost path is proved live on a host worktree. In a container
under heavy host load the tab's catalogue lags the backend's (0710); the same
file passed in containers at low load earlier the same day.

### Validation (2026-10-23)

- `mise run format:check`, `mise run lint` and `mise run typecheck` pass.
- `mise run test`: the root, bridge and Codex protocol groups pass. The
  workspace group's failures were load timeouts while live runs shared the
  host. Every owning file passed alone (existing flakes 0258, 0514, 0518, 0661,
  0691 and 0093; new 0711 and 0712), except two:
  - `agent provider module boundaries > keeps every provider implementation
    module within 1,500 lines`: real, caused by this branch, fixed by sharing
    the three `commandRevision` mappings (`commandCatalogueRevisionField`).
  - `executable document policy in firefox > popups, new-window links and top
    navigation reach the sink zero times`
    (`content-server.engines.test.ts`) fails alone too: this host's Firefox
    fetches `/favicon.ico` from the sink origin. The branch changes nothing
    under `transcript-artifacts`; not checked on `main`.
- The backend suite run on its own afterwards: 10,155 pass, 5 fail, the four
  load timeouts passing alone and the Firefox case above.

## Outstanding work

### Qualification

1. **Mixed versions against real old builds.** The matrix above uses fakes.
   Still unproven: a real old bridge, a real older renderer bundle in a
   browser, and an older backend's sync-v1 polling.

   **Which builds count (decided 2026-10-24 by
   [0034](../cross-cutting/0034-mixed-version-compatibility.md), written in
   [`version-compatibility.md`](../../architecture/version-compatibility.md)).**
   The window covers published releases from the floor, which is v2.21.0
   today and moves to the newest Stable release at least 60 days old. Pre-#827
   builds (`ff4026b4e^`, v2.20.x) were never published and are outside it, so
   the pre-#827 run is no longer required, and neither is the pre-#599 404
   path. The oldest build that counts is v2.21.0, which already serves the
   version 1 catalogue. The only change to the catalogue protocol since then
   is #1184's `normalizeAvailability`: a v2.21.0 backend still drops an
   availability state it does not know, which no current bridge sends.

   What is left: build the bridges, backend and renderer from `v2.21.0` into
   a disposable profile, pair a v2.21.0 bridge with a current backend and the
   reverse, run the scenario, and serve the v2.21.0 renderer against a current
   backend while watching for "Invalid native agent projection update
   response". Move the target to the floor if it has moved by the time this
   runs.

## Constraints and rationale

- Mocks do not confer support. A category that is not qualified stays
  unavailable with a reason.
- Use disposable provider homes and the profile's fixture project, never this
  repository or production sessions.
- Do not commit raw provider recordings. Codex recordings go through
  `scripts/scrub-codex-recording.ts` and a manual review.
- Diagnostics may record operation class, provider, counts, latency and
  allowlisted error codes. Never log command names, arguments, skill or
  template paths, prompts or file contents.
- Do not describe a release as "full slash-command parity"; name the provider
  surfaces that were qualified.
- Orkestrator's `projectResources` decides Grok's folder trust when it is on.
  The bridge sets `GROK_FOLDER_TRUST=0` for that child only. It does not write
  a durable grant with `--trust`: that would change the user's own
  `~/.grok/trusted_folders.toml`, and outlive the session and its policy. It
  does not answer Grok's `x.ai/folder_trust/request` either: that is
  undocumented, and the pinned build never sent it headless. When the policy
  is off, Grok's own trust still decides; see the follow-up in the index.
- A restarted bridge refuses a request id an earlier process claimed. It does
  not run it again, because the turn may already have run, as in the
  running-turn restart. The backend tells the user it may not have run, rather
  than leaving a retry card that can never succeed.

## Assumptions and decisions

Made on 2026-10-23 while closing items 1 to 5 and both follow-ups.

1. **Mixed-version window.** No support window is agreed (0034).
   - Options: wait for 0034; test only the previous release; test the shapes
     immediately before the version 1 catalogue (#827, `ff4026b4e^`).
   - Chosen: the pre-#827 shapes, plus a version 1 bridge missing optional
     fields and an unknown future version.
   - Why: #827 is the only wire break in the catalogue's history, so it is the
     oldest shape any window could include; waiting would have left the matrix
     untested.
   - Pros: covers every shape a plausible window contains, and found two real
     defects. Cons: if 0034 picks a longer window (before #599), the pre-#599
     bridges are covered only by the 404 path, and nothing was run against a
     real old build (outstanding item 1).
   - Update 2026-10-24: 0034 chose a window starting at v2.21.0, newer than
     #827, so the matrix covers more than the window needs and the con about
     pre-#599 bridges no longer applies.
2. **Pi credentials.** The host has an OAuth Pi login with a rotating refresh
   token.
   - Options: copy `auth.json` into the disposable agent directory; share it
     by path with `PI_BRIDGE_AUTH_FILE`; skip Pi again.
   - Chosen: share by path, everything else disposable.
   - Why: a refresh made from a copy would rotate the host's token away and
     sign the user out of `pi`. The bridge already supports this for
     agent-test profiles.
   - Pros: no credential copies, the host login survives. Cons: the probe can
     refresh the host's token (as running `pi` would) and spends a few short
     model turns on the user's plan.
3. **Pi literal step without tools.** With tools allowed the model read `.pi/`
   and imitated the commands, which makes a nonce prove nothing. Chosen:
   `approvals: "deny"` for the literal and control sessions, plus a count of
   model turns. Pro: the nonce can only come from expansion. Con: it does not
   show what a tool-enabled literal turn does, which is the model's business,
   not the opt-out's.
4. **Codex disabled skills at the protocol level.**
   - Options: a full Orkestrator session with a disposable `CODEX_HOME`; the
     pinned `codex app-server` called directly with one.
   - Chosen: the app-server directly, plus the existing bridge mapping tests.
   - Why: the bridge passes app-server's `enabled` flag through
     `skillUnavailability` unchanged, and the open question was what Codex
     reports. Pros: no sign-in, no host `~/.codex`, seconds to run, repeatable.
     Cons: the bridge-to-browser path for a disabled row is proved by unit
     tests, not live.
5. **Refresh coalescing.**
   - Options: keep concurrent refreshes (status quo); join the refresh in
     flight; one running plus one queued refresh per key.
   - Chosen: one running plus one queued.
   - Why: joining the running refresh can hand a caller a list read before its
     own request (a file added after the reload started would be missed). The
     queued refresh starts after every caller that joined it.
   - Pros: at most two reloads per burst, no false `failed`, every caller sees
     a list at least as new as its request. Cons: a caller arriving mid-refresh
     waits for up to two refreshes.
6. **Lost Claude dispatch.**
   - Options: keep the card and let Retry report the loss (status quo); keep
     the parked record with a new `lost` status the card renders; clear the
     record and project a separate content-free `retiredDispatch` marker plus a
     notice.
   - Chosen: a new in-band `lost` answer from every bridge that can tell, and
     the third option in the backend.
   - Why: a parked record blocks the whole session, so keeping it costs the
     user a click for nothing; a separate marker lets the tab, mounted or not,
     restore the draft the same way the retry path already does, and a notice
     covers older renderers.
   - Pros: no click, the session unblocks at the first reconciliation, the
     draft survives inactive environments. Cons: a new optional wire value and
     projection field (older sync-v1 delta readers refuse it), and the Claude
     bridge reads a not-yet-loaded session's preferences file to answer.
7. **Container scenario.**
   - Options: a separate container spec; the same spec with a parameter;
     container steps marked skipped where awkward.
   - Chosen: one parameter, no policy override, files through `docker exec`,
     no skipped step.
   - Why: the container default (`projectResources` on) is what users get,
     and `/workspace` is a clone inside the container, not a host mount.
   - Pros: one scenario, both kinds. Cons: the container variant needs a
     profile started with container fixtures and a built image.
8. **Re-probing after upgrades (the open question).** Chosen: re-qualify the
   moved provider on every pin change, with the scripted probes for all and
   the browser scenario for Codex and Claude, written into
   `upgrade-agents.md`. Rejected: only on a major version (minor releases
   changed command behaviour before, e.g. Grok folder trust), and never (the
   tables would claim versions nobody checked). Con: a few minutes and a few
   model turns per upgrade.
9. **Spec adjustments from the live runs.** Options for the failures that were
   timing, not product: leave them failing; raise every wait; change only the
   diagnosed waits and record the rest. Chosen: the last. The stale-draft
   refusal waits 30 s (measured 5.7 s under load) and an `unknown` retry is
   retried again (cause filed as 0059). The picker symptom keeps its 30 s wait
   and is flake 0710. Pro: the scenario stays strict where the cause is
   unknown. Con: 0710 can still fail a container run until it is fixed.
   After Multi Review the new first picker step got the same 30 s as every
   other picker wait; the return-after-refresh wait stays at 5 s because a
   refreshed list reaching the tab late is the behaviour 0710 tracks.
10. **Small defects found by the matrix were fixed here** (unknown availability
    state ran a command; Claude's sync-v1 snapshot dropped `commandRevision`),
    because both were small, each is pinned by a new test, and one was a
    safety issue. The larger limits (sync-v1 delta strictness, error codes)
    are recorded above and in tests rather than changed, because changing them
    needs the support window.

## Open questions

None. Re-probing after an upgrade is decided above (decision 8) and written into
[`upgrade-agents.md`](../../development/upgrade-agents.md#repository-wide-validation).

## Needs verification

None. The question whether these runs happened informally after #827 is moot:
the 2026-10-17 and 2026-10-23 records above are the qualification.

## Related

- [0016-slash-command-catalogue.md](0016-slash-command-catalogue.md) for code items and
  the legacy-route retirement this matrix gates.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  for credentials, profiles and batching with other provider runs.
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md).
- [`native-agent-commands.md`](../../architecture/native-agent-commands.md),
  [`agent-testing.md`](../../development/agent-testing.md),
  [`testing-guide.md`](../../development/testing-guide.md).

## Replaces

- `docs/improvements/slash-commands/plan/01-qualify-provider-contracts.md`
  (live probes, items 4 to 7, and the provider questions)
- `docs/improvements/slash-commands/plan/11-composer-and-command-feedback.md`
  (the real-browser cycle; the composer work is done)
- `docs/improvements/slash-commands/plan/12-validation-and-rollout.md`
  (inactive-environment scenario, containers, mixed versions, performance)
- `docs/improvements/slash-commands/plan/10-grok-and-cursor.md` (the Grok
  `session/load` re-send probe)
- `docs/improvements/slash-commands/qualification.md` (support, unavailable
  and literal-suppression tables and design findings moved to
  `native-agent-commands.md`; the blocked live probes ran on 2026-10-17, see
  the record above; the branch validation run was dropped)
