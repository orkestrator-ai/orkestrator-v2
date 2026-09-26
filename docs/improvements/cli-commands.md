# CLI commands for composability and targeted testing

Status: Proposed — code review and implementation recommendations; commands
below are proposed unless explicitly described as existing.

Implementation plans: [CLI commands plan index](cli-commands/plan/00-cli-commands-index.md).
The numbered plans track proposed work and verification; implementation has not
started.

Reviewed on 2026-09-26 against `06af4d86`. This was a source review of the CLI,
gateway, project/environment commands, native-agent control, Control MCP, and
test-profile infrastructure. No runtime benchmarks or live-agent experiments
were performed.

## Recommendation

Extend the published `orkestrator` executable with a client command surface for
projects, environments, agent sessions, and individual prompt runs. Keep the
existing backend as the authority for all mutations and ongoing work. The CLI
should authenticate to that backend, submit an action, and print a stable
receipt or result.

The repository already has most of the underlying actions. The main work is
making their contracts suitable for independent callers: explicit targets,
validated patches, predictable output, request-specific completion, durable
retry semantics, and connection discovery. A second implementation of worktree,
Docker, or agent orchestration in the CLI would duplicate the most delicate
parts of the application.

This would let shell scripts, CI, developer tools, and coding agents compose
Orkestrator operations without keeping a browser open. It would also give tests
a supported way to prepare and inspect a precise environment. It would not
make model output deterministic or replace tests of the actual desktop UI.

## What the code already provides

| Area | Current implementation | Implication for a CLI |
| --- | --- | --- |
| Published executable | [CLI shim](../../packages/cli/bin/orkestrator.js) sets resource defaults and imports the backend entrypoint. [Build script](../../packages/cli/scripts/build.ts) bundles the backend and bridge resources. | There is an existing distribution channel, but no project/environment command dispatcher. Client commands need a separate entrypoint that does not initialize a backend. |
| Command transport | [Gateway handler](../../apps/backend/src/gateway-handlers.ts), `handleInvoke`, accepts `POST /__orkestrator/invoke` with `{command,args}` and returns `{result}` or `{error}`. [Authentication](../../apps/backend/src/gateway-auth.ts) accepts a bearer token. | A CLI can exercise the same backend command boundary as the web client without Electron IPC or browser login. |
| Backend composition | [Command registry](../../apps/backend/src/core/commands-registry.ts) registers commands against a shared context and services. | Put new business operations here and reuse existing services, ownership checks, and lifecycle queues. |
| Projects | [Project commands](../../apps/backend/src/core/commands-registry-projects.ts) expose `get_projects`, `get_project`, `add_project`, `create_project_from_scratch`, `update_project`, `remove_project`, and repository configuration reads/updates. | Listing, registration, creation, metadata edits, and settings already have backend entrypoints. |
| Environments | [Environment commands](../../apps/backend/src/core/commands-registry-environments.ts) expose create, fork, rename, start, background start, stop, recreate, delete, setup, ports, domains, and agent settings. | A useful first release can wrap existing actions, with explicit semantics for setup readiness and settings application. |
| Independent agent jobs | [Control commands](../../apps/backend/src/core/commands-registry-control.ts), `launchNativeAgentJob`, create a stable tab, ensure a session, and dispatch its prompt before returning. | New conversations can start without a mounted tab. `launch_control_job` validates an explicitly selected model against the catalogue. |
| Existing conversations | [Native-agent commands](../../apps/backend/src/core/commands-registry-native.ts) expose dispatch, retry/discard, projections, transcript pages, stop, resume/fork, control updates, actions, and interaction resolution. | Prompting and control can use the shared provider abstraction instead of constructing provider CLI invocations. |
| Initial prompts | [Startup reconciliation](../../apps/backend/src/core/native-agent-service-reconciliation.ts) consumes persisted launch intent and uses the `startup-agent` tab and a stable initial-prompt request ID. | Combined environment creation and first prompt should reuse this backend-owned path. |
| Agent-facing controls | [Control MCP](../../apps/backend/src/core/control-mcp-server.ts) already supplies discovery, `launch_environment`, `launch_job`, `send_prompt_to_tab`, and bounded tab transcripts. | Useful validation and tab resolution already exist, but some live inside the MCP adapter and should be extracted for reuse. |
| Terminal jobs | [Terminal commands](../../apps/backend/src/core/commands-registry-terminal.ts), `launch_terminal_job`, create and bootstrap a stable backend-owned PTY. | Terminal control is possible, but PTY startup is not a structured command-completion result. |
| Isolated testing | [Fixture seeding](../../apps/desktop/scripts/dev/fixture.ts) already calls the gateway using its auth file. [Browser gateway tests](../../e2e/agent-testing/browser-gateway.spec.ts) manually invoke commands to create/start environments and inspect terminal state. | CLI commands would formalize a pattern already used by tests and reduce repeated transport and setup code. |

## Findings that affect the design

### 1. Separate service startup from client execution

Every invocation of the current package shim imports `dist/main.js`, whose
[source](../../apps/backend/src/main.ts) initializes storage, services, listeners,
and lifecycle supervision. Adding argument handling after that import would
make even a list or help command start backend infrastructure.

Add explicit `orkestrator serve` while preserving the existing no-subcommand
and legacy server-flag forms. Route recognized client subcommands to a small
client bundle before importing the service. Reject unknown subcommands and
flags; a typo must not fall through to starting the service. Help and version
must work without a running backend.

Client commands should attach to an existing instance and fail clearly if it
is unavailable. Automatic startup is a separate opt-in design decision: it
needs process ownership, readiness, and data-directory exclusivity. Starting
another backend over the desktop's data directory is not a valid fallback.

### 2. Project creation has external effects; project editing has multiple meanings

[Project creation](../../apps/backend/src/core/commands-projects.ts) distinguishes
registration/cloning from creation from scratch. `addExistingProject` can
register a remote, attach an existing local checkout, or clone into a missing
or empty target. `createProjectFromScratch` initializes Git, creates an initial
commit, creates a **private GitHub repository**, and pushes `main`.

Consequently, a command named `project create` must make the remote-creation
choice explicit. Do not present the existing scratch operation as a local-only
fixture initializer. A local-only `project init` would need a deliberately
supported backend operation. Credential-free tests can already use the fixture
seeder's local repository plus bare origin and then register that project.

`update_project` changes stored metadata; it does not move the checkout or
rewrite its Git remote. `update_repository_config` changes a separate settings
record. Expose these as metadata and settings operations, and document when a
setting applies to future environments, the next start, or an existing session.
Changing an environment's inherited agent defaults and changing a live
session's model are likewise different operations.

Project removal also needs a product-level contract. The current
`remove_project` handler cleans up coordinator/mail state and removes the
project record; it does not perform the environment lifecycle deletion loop.
See [storage](../../apps/backend/src/core/storage-projects.ts), `removeProject`.
A public `project remove` should refuse while child environments exist, or
offer an explicit backend-owned cascade that reports each cleanup result.
Removing a registration must never imply deleting a GitHub repository.

### 3. Request deduplication exists, but it is not yet a universal operation contract

`create_environment` accepts `controlRequestId`; `StorageService.addEnvironment`
deduplicates under its mutation queue. The
[concurrent retry test](../../apps/backend/src/core/commands-registry-environments-control.test.ts)
proves that two callers converge on one environment. However, a matching ID
returns the existing environment without comparing the new creation payload.
Reusing an ID with a different name, provider, or prompt can therefore conceal
a caller mistake. The deduplication record also lives on the environment, so
deleting the environment removes that evidence.

Job launch derives stable job/tab IDs from environment ID and request ID.
Native dispatch has its own pending-dispatch and reconciliation machinery.
These are valuable foundations, but they should not be advertised as one
unbounded, exactly-once guarantee across creation, restarts, deletion, and all
providers.

For the public actions, define the request-ID scope and retention period, bind
each ID to a canonical payload fingerprint, and reject conflicting reuse.
Persist receipts/tombstones separately where resource deletion would otherwise
make an old action executable again. Extend existing journals where possible.
Bound both record count and bytes and report expired history explicitly.

### 4. Accepted, ready, idle, and completed are distinct results

[`NativeAgentDispatchOutcome`](../../packages/protocol/src/native-agent.ts)
reports `accepted`, `rejected`, or `unknown`. Accepted means dispatch was
acknowledged; it does not identify a successfully completed turn.
`start_environment_background` acknowledges admission while work continues in
the backend. A running environment can still have incomplete setup, and job
launch explicitly checks setup readiness.

The missing public abstraction is a durable receipt for one requested action,
with a queryable outcome. Build/review workflows have their own richer state;
ordinary prompt dispatch does not expose an equivalent general run contract
in the reviewed commands.

A CLI `run wait` must follow the particular request, not wait for the whole
environment to become idle. Otherwise it can return before a turn starts,
mistake a disconnected provider for completion, or wait forever because another
tab is working. Correlate request ID, logical session, provider session/turn,
and authoritative terminal outcome. Where a provider cannot prove completion,
return an explicit unknown or unsupported result. Do not infer success from
assistant wording or an idle snapshot.

### 5. Reuse Control MCP behavior without making it a second domain layer

Control MCP already validates launch options, resolves native tabs, and bounds
transcript reads. Its ordinary tool set does not provide all project edits and
session controls; start/stop tools are registered in the coordinator-specific
branch. It is therefore useful precedent, not a complete CLI API.

Extract reusable launch/discovery/tab-resolution actions from the MCP adapter
into backend services or registered commands. Both transports can then call
them. Preserve coordinator scope checks and trusted delegation provenance:
an ordinary operator CLI must not obtain coordinator authority by supplying
coordinator-shaped request fields.

Prefer the existing authenticated gateway for the first CLI client. An MCP
client implementation would still need new tools for missing operations and
would couple basic shell operations to MCP session handling. Do not add another
HTTP server solely for the CLI. Keep any raw `rpc invoke` escape hatch clearly
marked internal/unstable; the supported interface should be named actions with
validated input and output contracts.

### 6. Transport errors need machine-readable meaning

The gateway currently returns HTTP 500 with an error string for exceptions
from registered commands. Some successful HTTP responses also carry a domain
outcome such as rejected or unknown dispatch. A shell wrapper that only checks
HTTP status would report misleading success or retry unsafe work.

Add stable domain error codes and structured outcomes for the public actions,
retaining compatibility with existing gateway callers. Decode domain outcomes
as well as transport status. Do not classify errors by matching English text.
Older backends lacking the required contract should produce a compatibility
error before a dependent mutation is attempted.

## Proposed command surface

Use singular resource names and stable IDs. Names can be optional conveniences
when unique within an explicitly selected scope; reject ambiguity rather than
choosing the first match. Never target the desktop's currently active tab.

| Proposed command | Meaning and implementation direction |
| --- | --- |
| `serve` | Existing foreground backend behavior, with current flags retained. |
| `connection list/show/check` | Select and verify the intended backend; report identity and capabilities without credentials. |
| `project list/get/add` | Inspect/register a repository or clone to an explicit backend path through existing project commands. |
| `project create --path … --github-private` | Explicit wrapper around scratch creation and its GitHub effects. Local-only initialization is separate future work. |
| `project update`, `project config get/set/unset` | Validated metadata patches and repository settings patches, with effective values and application timing. |
| `project remove` | Remove registration after child-environment checks; optional cascade requires a tracked backend operation. |
| `environment list/get/create` | Create a workspace record with explicit project, type, optional name and base revision; creation alone does not launch an agent. |
| `environment start/stop/recreate/delete/fork/rename` | Existing lifecycle operations with an action receipt and optional bounded wait. `recreate` and delete expose their destructive effects. |
| `environment config get/set/unset` | Typed edits for supported ports, domains, and agent defaults. Reject unsupported live changes or report restart requirements. |
| `environment launch` | Convenience action: create, start, complete setup, and send the first prompt through persisted startup intent. |
| `agent options --environment …` | Enabled providers, current model catalogue, supported controls, and capability freshness. |
| `session list/get` | Public native-session identity plus environment/tab IDs, activity, pending interactions, and recoverable dispatch. Resolve layout/provider details in the backend. |
| `session start --environment … --agent …` | Launch a new independent conversation using the durable job path; return session/tab identity and prompt receipt. |
| `session prompt SESSION_ID` | Send a follow-up using `dispatch_native_agent_intent`; require a concrete conversation target. |
| `session stop/steer/config/resume/fork` | Shared native-agent actions, gated by the live provider capabilities. Stop-turn, resume-history, fork-conversation, and stop-environment retain distinct meanings. |
| `session interactions list/resolve` | Read authoritative pending questions/approvals and answer one exact interaction. Answers must match the current interaction/generation. |
| `session transcript` | Bounded message pages, with optional resumable following and explicit truncation/cursor expiry. |
| `run get/wait` | Proposed action-specific status and terminal result. Requires the durable receipt/completion work above. |
| `run retry/discard` | Map recoverable prompt/steer dispatches to existing retry/discard commands. Discard clears recovery intent; it does not undo a potentially executed turn. |

Prefer `session start` for parallel independent jobs in one environment, and
`session prompt` for continuation. An environment-level prompt shortcut should
require either an explicit session or `--new-session --agent …`. It must not
silently send to whichever conversation was last visible. Independent
conversations in one worktree still share files; use separate environments
when tasks require filesystem isolation.

Plain text, selected slash commands, steering, and queued follow-ups must keep
their distinct intent. Use the existing command catalogue and dispatch contract
for an eventual `session command`; do not convert a rejected selected command
into prompt text. See [native-agent commands](../architecture/native-agent-commands.md).
For a busy session, explicitly choose reject, enqueue where supported, or steer;
never change the caller's intent automatically.

## Contract for composition

### Connections and authority

Resolve an explicit `--connection` or development `--profile` first, then an
explicitly configured default. A stale or missing explicit profile must fail
without falling back to production. Paths passed to project commands refer to
the backend filesystem; prompt files and connection files refer to the caller's
filesystem. Make that distinction visible for remote backends.

The backend's readiness message already includes its URL and private auth-file
path. Development profiles have a validated status manifest with ephemeral
ports; see [runtime profiles](../../apps/desktop/electron/runtime-profile.ts) and
[profile I/O](../../apps/desktop/scripts/dev/profile-io.ts). Reuse those contracts
instead of guessing port 34121. An installed-client discovery contract still
needs defining; do not assume a development manifest exists for production.

Read a selected connection's credential in process and send it in the
authorization header. Keep it out of arguments, URLs, diagnostics, and output.
Gateway and Control MCP credentials are different credentials. Avoid automatic
discovery of an operator credential from inside a worker environment: a
project-scoped worker must not acquire full operator access merely because the
CLI is installed. Scoped automation credentials can be added explicitly using
the existing authority patterns.

### Input, output, and errors

- Support `--json` for one versioned result envelope and `--output id` for a
  single documented resource ID. Write progress/diagnostics to stderr; stdout
  must remain valid for pipelines. Following output uses explicit `--jsonl`.
- Define public summary fields instead of dumping raw storage records. Reuse
  existing client projections and redaction helpers; keep initial prompts,
  attachments, and credential-bearing configuration out of routine list/get
  output. Transcript/content retrieval is an explicit bounded operation.
- Accept `--prompt-file` and `--prompt-stdin`. Do not require multiline prompts
  in command arguments. Preserve content, validate bounds before dispatch, and
  never echo it in routine logs. File attachments need a defined upload and
  workspace-path lifecycle; they cannot be passed as remote host paths.
- Support structured patch files for settings, with an allowlist, type checks,
  and explicit unset/inherit semantics. Do not implement edits by loading and
  saving the entire application configuration. Add expected-revision conflict
  checks where concurrent UI and CLI edits could overwrite one another.
- Return effective settings and whether they applied now or require a future
  session/start. Capability discovery must distinguish stale/unavailable from
  a successful empty catalogue; do not silently substitute a provider/model.
- Make `--request-id` available on side-effecting actions. For generated IDs,
  retain a private local receipt before sending so a lost response does not
  lose the recovery key. Persist the authoritative operation in the backend;
  a client receipt alone cannot prove dispatch or completion.
- Use a documented exit-code mapping, for example: `0` requested condition
  satisfied, `1` operation failed, `2` invalid arguments, `3` target absent or
  ambiguous, `4` auth/connection failure, `5` wait deadline, `6` interaction
  required, `7` unknown dispatch, `8` conflict/unsupported capability. Return
  the precise reason in a stable JSON code. A successful submission without
  `--wait` means accepted only; completed waits must report their final result.
- Do not blindly retry a timed-out mutation. Reconcile by the same request ID
  and use the backend's explicit recovery operation. Never mint a new ID to
  bypass a parked session dispatch. Define how long a receipt remains queryable
  and fail explicitly when evidence is no longer retained.

### Waiting and disconnection

Expose separate environment conditions such as `running`, `ready`, `stopped`,
and `deleted`. Ready should reflect the backend's setup-complete predicate and
report whether setup was explicitly overridden. A CLI must not invoke setup
override just to make a wait succeed.

For prompt runs, retain dispatch state separately from execution state:
accepted/unknown/rejected dispatch; pending/running/waiting-for-input/completed/
failed/cancelled execution. Record timestamps, IDs, and failure reasons without
duplicating full transcripts. A completed provider turn still needs a separate
test or artifact assertion to prove the user's requested change was correct.

Start with bounded polling of lightweight backend snapshots. Watching should
not repeatedly hydrate full transcripts or reattach idle provider sessions;
the bridges' `/activity` endpoints exist to avoid those side effects. Add event
following as an optimization with revision/generation reconciliation, bounded
buffers, cursor expiry, and snapshot recovery. A missed event must not become
a permanently missed completion or approval.

Ctrl+C or a wait timeout should stop observation while accepted backend work
continues. Print the receipt needed to reconnect. Explicit stop/cancel is a
separate action and must not claim success before the provider acknowledges
it. An outstanding approval remains backend-owned when a CLI exits; timeout,
malformed answers, or dead generations must never cause implicit approval.

## What this enables

The following is illustrative **future syntax**, not a script supported today.
Assume `cli-qa` is an already-running isolated profile and its fixture project
ID is supplied as `PROJECT_ID`. A separate environment per scenario allows
parallel investigations without sharing a worktree.

```bash
set -euo pipefail
umask 077

# Caller supplies a unique, stable ID for this scenario attempt.
: "${SCENARIO_ID:?set a stable scenario attempt ID}"
: "${PROJECT_ID:?set the isolated fixture project ID}"

ENV_ID=$(orkestrator --profile cli-qa environment create \
  --project "$PROJECT_ID" --type local --name "$SCENARIO_ID" \
  --request-id "$SCENARIO_ID:create" --output id)

orkestrator --profile cli-qa environment start "$ENV_ID" \
  --wait ready --timeout 120s --json

# JSON contains stable sessionId, tabId, requestId, and runId fields.
orkestrator --profile cli-qa session start --environment "$ENV_ID" \
  --agent codex --prompt-file ./scenario-prompt.txt \
  --request-id "$SCENARIO_ID:prompt" --json > launch.json

RUN_ID=$(jq -er '.result.runId' launch.json)
SESSION_ID=$(jq -er '.result.sessionId' launch.json)

orkestrator --profile cli-qa run wait "$RUN_ID" --timeout 180s --json
orkestrator --profile cli-qa session transcript "$SESSION_ID" \
  --limit 30 --json > transcript.json

# Assert expected files/test results separately before considering this a pass.
orkestrator --profile cli-qa environment delete "$ENV_ID" \
  --wait deleted --timeout 120s --json
```

The surrounding test runner must own a `finally` cleanup path, persist created
IDs immediately, and retain useful failure evidence before deletion. It should
record cleanup failures rather than swallowing them. This example omits that
harness for readability; it is not a complete test runner. Live provider runs
remain opt-in and credentialed, and transcript artifacts require the existing
privacy/sanitization rules.

These primitives support several practical compositions:

- Reproduce a bug from a fixed base commit in a named environment, apply exact
  project/environment settings, submit a prompt, and collect bounded evidence.
- Run one scenario against multiple providers, each in its own environment,
  and compare structured outcomes and file assertions. Do not compare prose
  as a proxy for correctness.
- Let a shell pipeline or external task runner create workspaces and launch
  independent jobs, then resume observation later using saved receipts.
- Prepare an exact state through the CLI before opening the desktop directly
  at the environment under test. This isolates UI assertions from unrelated
  setup dialogs while retaining dedicated tests of those dialogs.

An `environment exec -- <argv…>` command would also help run focused repository
checks inside the selected workspace. Treat it as a second-stage feature:
`launch_terminal_job` reports PTY bootstrap, not the exit status of an individual
shell command. A supported exec operation needs backend-owned process/run
identity, cwd/environment rules, bounded stdout/stderr, deadline, cancellation,
and exit status for both local and container environments. Reuse appropriate
review-validation execution machinery where possible; do not decide success
by scraping a terminal marker or sending shell keystrokes.

## Targeted testing strategy

Follow the [testing guide](../development/testing-guide.md) and
[isolated agent-testing guide](../development/agent-testing.md). CLI scenarios
should integrate with the existing profile owner, fixture seeder, capacity
queue, watchdogs, and bounded failure artifacts. Do not build a second profile
manager or routinely create projects through GitHub to obtain a test fixture.

| Layer | Focused coverage | Boundary it proves |
| --- | --- | --- |
| CLI unit/contract | Argument errors, target resolution, JSON purity, exit codes, stdin/file limits, connection precedence, unsupported server capabilities, receipt persistence. | The executable translates caller intent reliably. Use a small controlled transport fixture. |
| Real backend + disposable storage | Project/settings patches, environment lifecycle receipts, request conflicts, concurrent retries, result expiry, deletion semantics. | Public actions use the same authoritative state as other clients. |
| Scripted provider/bridge boundary | Acknowledge, delay, reject, ask a question, lose an acknowledgement, complete while unobserved, restart/reconcile, and cancel. | Deterministic orchestration and recovery without spending tokens. Reuse provider fakes and bridge fixtures. |
| Real local-worktree CLI smoke | Register fixture project; create/start/setup; inspect paths/base; run a bounded command; stop/delete; confirm owned resources are gone. | Packaged client → gateway → real backend → actual worktree/process behavior. |
| Focused browser/Electron | Prepare through CLI, open environment, switch away during execution, return after completion or an interaction, then reload. | UI rehydration, controls, and event/snapshot integration. |
| Opt-in live provider and Docker | One bounded scenario per capability/provider and container ownership/lifecycle checks. | Real toolchain, provider transport, authentication, and container behavior. |

High-value regression scenarios are:

1. Launch a prompt and exit the CLI immediately. Run another environment, then
   reconnect and verify the first request's completion and transcript. Repeat
   with a pending question/approval, and add the actual UI switch-away path.
2. Lose the prompt response after provider acceptance. Verify unknown status,
   same-ID reconciliation, and exactly one provider submission in the scenario.
   Attempt a different prompt while recovery is parked and verify refusal.
3. Reuse an environment-create request ID concurrently; assert one environment.
   Reuse it with different payload and require a conflict. Delete the resource
   and retry within retention to verify no accidental recreation.
4. Fail setup after environment creation. Verify `--wait ready` fails with the
   recorded reason and the initial prompt remains undispatched. Successful
   backend readiness is not successful environment setup.
5. Restart the backend/bridge between acceptance and observation. Verify the
   receipt is reconciled or explicitly interrupted/unknown, never silently
   reported completed or redispatched.
6. Run multiple sessions in one environment. Verify a wait follows only the
   selected request and a targeted stop leaves unrelated sessions running.
7. Concurrently edit settings from UI and CLI. Verify unrelated fields survive,
   stale revisions conflict, unset restores inheritance, and effective values
   describe live versus next-start behavior.
8. Supply a missing/stale test profile or a foreign Docker owner. Verify the
   command fails without falling back to production or altering foreign state.

Existing focused coverage to extend includes
[project creation](../../apps/backend/src/core/commands-project-creation.test.ts),
[local worktrees](../../apps/backend/src/core/commands-local-worktree.test.ts),
[control jobs](../../apps/backend/src/core/commands-registry-control.test.ts),
[native dispatch](../../apps/backend/src/core/native-agent-service-dispatch.test.ts),
[reconciliation](../../apps/backend/src/core/native-agent-service-reconciliation.test.ts),
and [packaged CLI tests](../../packages/cli/tests/cli.test.ts). Keep domain
edge-case tests near those owners; do not duplicate every assertion through a
subprocess. A few packaged CLI scenarios should prove the entire connection.

The speed benefit is primarily shorter setup and diagnosis for real-stack
scenarios: select one environment/provider/operation without navigating the
whole application. Browser suites already run separately from the default
suite, so adding a CLI does not inherently shorten `mise run test`. Measure
scenario startup time, time to failure evidence, flake rate, cleanup success,
and live-provider cost before claiming a performance improvement.

## Suggested implementation sequence

1. **Client boundary and discovery.** Split service/client entrypoints, retain
   launcher compatibility, add help/version and explicit connection selection,
   and expose list/get/options commands. Define versioned output and capability
   negotiation; test the packed executable without accidentally starting a
   service for client commands.
2. **Project/environment control.** Wrap existing lifecycle operations; add
   validated partial edits, request conflict detection, readiness conditions,
   and cleanup semantics. Deliver a credential-free local-worktree CLI smoke
   using the existing isolated fixture infrastructure.
3. **Prompt/control contract.** Extract shared MCP actions, expose session
   launch/follow-up/transcript/control/interaction commands, and implement
   durable request-specific receipts and completion. Qualify unknown dispatch,
   disconnect, restart, and multiple-session cases before offering `run wait`
   as an automation success signal.
4. **Broader composition.** Add bounded exec and optional resumable event
   following, then adapt selected browser setups and live-agent probes. Add
   higher-level scenario or declarative `apply` support only after the primitive
   actions have proven useful; shell/task-runner composition is enough first.

The first useful deliverable is a thin, supported client plus one isolated
local-worktree scenario. The complete target is a backend-authoritative
create/edit/start/prompt/control/wait/inspect/cleanup flow that stays correct
when the invoking process and the visible environment both change.
