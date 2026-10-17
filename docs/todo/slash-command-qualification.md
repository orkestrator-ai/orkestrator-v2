# Slash-command qualification

Checked against `main` at `31d0fb06` (2026-10-17).

Every slash-command executor was first qualified from installed SDK
declarations and source, then exercised through each integration's real
execution path with transport-level fakes. The live provider probes and the
inactive-environment browser scenario then ran on 2026-10-17 (record below).
This file collects the evidence still needed before the feature can be called
complete. Failures found here become code items in
[slash-command-catalogue.md](slash-command-catalogue.md).

## Current state

- The per-provider support, unavailable-command and literal-suppression tables
  are in [`native-agent-commands.md`](../architecture/native-agent-commands.md#provider-support).
  They still carry the 2026-09-23 source-and-fakes pins and caveat; item 5
  below updates them from the live record.
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
    worktree were not listed (see "Needs verification").
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
  (`context.setOffline`) that forces stream reconciliation, and a catalogue
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

On Claude the stale-draft step is skipped: a removed command leaves Claude's
list only at its next turn.

Not run: the scenario on a container environment (item 1 below), with a
backend restart (a `dev:test` profile cannot restart its backend alone), and
on OpenCode, Grok or Pi (the spec supports Codex and Claude). Whether a refresh
keeps an idle session attached was checked by hand only: Claude (no CLI left
under the bridge, list stays `missing` until a refresh) and Grok (list stays
`stale`, so no `session/load`).

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
[0273](../tests/flaky-tests/0273-claude-live-slash-provider-result.md), with the
failed combined command and evidence. Both providers therefore passed against
the final code; the JSON report above now contains the final Claude-only run.

Validation: the four focused Claude suites, the backend progressive,
projection and command suites, `format:check`, `lint` and `typecheck` passed.
The final `mise run test` passed the workspace, all five bridges and
Codex protocol groups. Its only failure was the existing
`tests/unit/flaky-tests-index.test.ts`: record
`docs/tests/flaky-tests/0265-command-fixture-hooks-aggregate-timeout.md` lacks
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
  [composer-model-parameters.md](composer-model-parameters.md).
- A dev profile's backend reports the Electron version, which raises a
  version reminder over the composer's Send button
  ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md),
  code item 3).

## Outstanding work

### Qualification

1. **Containers.** Check that skill and template paths resolve inside the
   provider's environment, not on the host or in the renderer, and run
   `slash-command-inactive.spec.ts` against a container environment (it takes
   `environmentType: "local"` today; make it a parameter).
2. **Pi and the remaining provider gaps.**
   - Pi 1.2.0 with credentials: discovery, extension-before-template
     precedence, headless extension completion, whether `reload()` is still
     unsafe mid-turn, and the literal opt-out (`expandPromptTemplates: false`).
   - Codex disabled skills, with a disposable `CODEX_HOME` whose
     `config.toml` disables one skill.
3. **Mixed-version matrix.** New backend with an old bridge, old backend with
   a new bridge, and old and new renderer projections, within the support
   window decided in [slash-command-catalogue.md](slash-command-catalogue.md).
4. **Performance**, with synthetic large inventories:
   - cold and warm discovery latency (p50 and p95);
   - refresh coalescing;
   - retained catalogue bytes against the 16 MiB cache budget
     (`COMMAND_CATALOGUE_MAX_BYTES`);
   - provider probe count.

   Opening the picker must not trigger a provider process or filesystem scan
   per keystroke. Report measured numbers; do not set latency claims in
   advance.
5. After a pass, update the qualification paragraph and tables in
   `native-agent-commands.md` "Provider support" (pins, and drop the "no live
   session" caveat for what passed), and the owner comments listed in
   [slash-command-catalogue.md](slash-command-catalogue.md).

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

## Open questions

- Should qualified rows be re-probed after every agent SDK or CLI upgrade? See
  [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).

## Needs verification

- Whether any of these runs happened informally after #827. No artifacts or
  records were found.
- Whether Grok 1.0.52 loads project skills and commands in a host worktree it
  has not trusted. The ACP bridge reports `projectResources: true`
  (`acp-policy.ts`), yet a worktree's `.agents/skills` skill and a
  `.grok/commands` file were not listed on 2026-10-17, while a user skill
  was. Check Grok's folder-trust state for the worktree and whether
  `.grok/commands` is a Grok convention at all.
- What a Claude user sees after a bridge restart right after Send. On
  2026-10-17 the dispatch parked (`action-required`), a retry under the same
  request id settled, and the command never ran. That is safe, but the
  command is lost after a retry. Check that the reconciling card and the
  transcript tell the user it did not run.

## Related

- [slash-command-catalogue.md](slash-command-catalogue.md) for code items and
  the legacy-route retirement this matrix gates.
- [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)
  for credentials, profiles and batching with other provider runs.
- [mixed-version-compatibility.md](mixed-version-compatibility.md).
- [`native-agent-commands.md`](../architecture/native-agent-commands.md),
  [`agent-testing.md`](../development/agent-testing.md),
  [`testing-guide.md`](../development/testing-guide.md).

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
