# Public CLI (`orkestrator` client commands)

Status: Living — operator and architecture guide for the client command
surface of the published `orkestrator` package.

Implementation plan and evidence:
[CLI commands plan](../improvements/cli-commands/plan/00-cli-commands-index.md).
Contract source: [`packages/protocol/src/public-api.ts`](../../packages/protocol/src/public-api.ts)
and [`public-api-resources.ts`](../../packages/protocol/src/public-api-resources.ts).

## Service versus client

One executable has two modes. The launcher
([`bin/orkestrator.js`](../../packages/cli/bin/orkestrator.js)) decides which
**before** the backend is imported, using
[`packages/cli/src/client.ts`](../../packages/cli/src/client.ts):

| Invocation | Mode |
| --- | --- |
| `orkestrator` (no arguments) | Foreground service, as before |
| `orkestrator serve [service options]` | Foreground service (explicit form) |
| `orkestrator --host … --port … …` (only service flags) | Foreground service (historical form) |
| `orkestrator <group> <command> …`, `help`, `version`, `--help`, `--version` | Client |
| Anything else (typos, stray words, service flags mixed with client options) | Refused, exit 2 |

Service flags are inventoried in
[`apps/backend/src/server-flags.ts`](../../apps/backend/src/server-flags.ts); a
test fails if `options.ts` parses a flag the inventory lacks. Client commands,
help and version never initialize a backend, create its data directory, or
start a listener, bridge or child process. Client commands **never start a
backend**: they attach to one that is already running.

## Selecting a backend

Resolution is explicit and never falls back:

1. `--profile NAME` — a running isolated development profile
   (`mise run dev:test --profile NAME`). The client reads the same status
   manifest `dev:status` reads, requires `status: "ready"` and a live backend
   PID, then uses that backend's instance descriptor.
2. `--connection NAME` — a saved connection.
3. Otherwise the saved default (`orkestrator connection default NAME`).

With none of these the command fails with `connection-not-configured` (exit 4).
There is no port scan and no implicit production default. `--profile` and
`--connection` together are refused.

### Instance descriptor

Once serving, the backend writes `<data dir>/backend-instance.json` (mode
0600, atomic rename): installation ID, per-start generation, PID, endpoint,
the **path** of the credential file (never the credential), data directory,
app version and public schema version. It is removed on graceful shutdown if
it still describes that generation. A descriptor whose PID is gone is stale and
is refused.

The installation ID is stable per data directory (a copied directory gets a
new one). Every public response carries `backend.installationId`/`generation`;
the client rejects an answer from a different installation than the one it
resolved (`identity-mismatch`), so a recycled port cannot silently bind a
receipt to another backend. A generation change within the same installation
(a restart) is allowed.

### Connections and credentials

```bash
# A backend on this machine: read its descriptor and private auth file per call.
orkestrator connection add local --data-dir "$HOME/.config/orkestrator-v2" --default

# A remote backend: the token comes from a private file or stdin, never argv.
orkestrator connection add laptop --url https://laptop.tailnet.ts.net --credential-file ~/.secrets/ork-token
printf '%s' "$TOKEN" | orkestrator connection add ci --url https://host.ts.net --token-stdin

orkestrator connection list | show NAME | check [NAME] | default NAME | default --clear | remove NAME
```

The client configuration lives in `ORKESTRATOR_CLI_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/orkestrator-cli` (Linux) or
`~/Library/Application Support/orkestrator-cli` (macOS): `connections.json`
(0600), `credentials/` (0600 files in a 0700 directory), `receipts/`. A config
file writable by others or a credential file readable by others is refused.
There is no project-local configuration, so cloning a repository cannot select
a backend or hand a worker an operator credential. `add` contacts the backend
and pins its installation ID unless `--no-check`. URLs with embedded
credentials are refused; plain `http` is accepted only for loopback and
Tailscale addresses.

Tokens travel only in the `Authorization` header. The transport never follows
redirects, bounds decoded responses (8 MiB), and re-reads the credential file
once after a 401 for reads only (token rotation) — never for a mutation.

## Output and exit codes

| Mode | stdout | stderr |
| --- | --- | --- |
| human (default) | Free-form text; may change between releases | Diagnostics, receipt hints |
| `--json` | Exactly one envelope, success or failure | Nothing on success |
| `--output id` | Only the documented ID(s); nothing on failure | The error |
| `--jsonl` | One record per line while following, then the final envelope | — |

The envelope (`PublicSuccessEnvelope` / `PublicErrorEnvelope`):
`{schemaVersion: 1, action, ok, connection, backend, result | error, receipt?, warnings?}`.
`error` is `{code, message, exitCode, retryable?, details?}` with a stable
`code`; the exit status groups codes into classes:

| Exit | Class | Examples |
| --- | --- | --- |
| 0 | Requested condition satisfied | |
| 1 | Operation failed | `operation-failed`, `setup-failed`, `run-failed`, `run-cancelled`, `run-interrupted`, `exec-failed`, `store-capacity` |
| 2 | Invalid input | `invalid-input`, `input-too-large`, `empty-input`, `unknown-command` |
| 3 | Target absent, ambiguous or expired | `not-found`, `ambiguous-target`, `history-expired` |
| 4 | Connection or authentication | `connection-failed`, `auth-failed`, `identity-mismatch`, `profile-unavailable`, `transport-uncertain` |
| 5 | Observer deadline | `deadline-exceeded` |
| 6 | Interaction required | `interaction-required` |
| 7 | Unknown dispatch or outcome | `dispatch-unknown`, `run-unknown` |
| 8 | Conflict or unsupported | `request-conflict`, `revision-conflict`, `namespace-expired`, `busy`, `not-ready`, `not-empty`, `capability-unavailable`, `backend-incompatible` |
| 130 / 143 | Observation stopped by SIGINT / SIGTERM (`observation-interrupted`) | |

An HTTP 200 carrying a rejected or unknown outcome is never a success. Errors
are never classified by matching English text; the one gateway message the
client recognizes is the gateway's own `Unknown backend command:` for a
backend that predates the contract (`backend-incompatible`).

## Command surface

Every command maps to one versioned public action entering the backend through
the single registry command `public_action`
([`apps/backend/src/core/public-api/`](../../apps/backend/src/core/public-api/)).
The raw registry is not exposed. `orkestrator connection check` lists which
actions a backend advertises; the client refuses a mutation the backend does
not advertise at its version before sending it.

| Command | Action | Backend owner reused | Effects |
| --- | --- | --- | --- |
| `project list/get` | `project.list/get` | storage snapshot | read |
| `project add --remote/--path` | `project.add` | `addExistingProject` (locks, duplicate/symlink guards, clone rollback) | metadata, filesystem |
| `project create --path P --github-private` | `project.create` | `createProjectFromScratch`: `git init`, **private GitHub repository**, push | metadata, filesystem, external |
| `project update ID` | `project.update` | revision-checked storage patch | metadata only — no directory move, no `.git/config` rewrite |
| `project remove ID` | `project.remove` | removal fence + `cleanupProjectForRemoval` | registration only; refused with environments (no cascade) |
| `project config get/set/unset` | `project.config.get/set` | config lock, content revision | metadata |
| `environment list/get` | `environment.list/get` | environment snapshot (no Docker sync) | read |
| `environment create` | `environment.create` | `create_environment` (control request ID + fingerprint) | metadata |
| `environment start/stop/recreate/delete` | `environment.*` | the registered lifecycle commands and queue | filesystem, process |
| `environment fork/rename` | `environment.fork/rename` | `fork_environment`, `rename_environment` (branch renamed too) | metadata, filesystem |
| `environment config get/set/unset` | `environment.config.get/set` | environment lock, content revision | metadata |
| `environment launch` | `environment.launch` | create + start + startup reconciliation's single first prompt | all |
| `environment exec ID -- ARGV…` | `environment.exec` | environment-side exec worker | filesystem, process |
| `agent options` | `agent.options` | model catalogues (`--refresh` asks providers) | read |
| `session list/get` | `session.list/get` | pane layout + native-session records (metadata only) | read |
| `session start` | `session.start` | `launch_native_agent_job` (durable job tab, exactly-once first prompt) | provider |
| `session prompt SESSION` | `session.prompt` | `dispatch_native_agent_intent` | provider |
| `session stop/steer` | `session.stop/steer` | `stop_native_agent_session`, steer session action | provider |
| `session config get/set` | `session.config.get/set` | live composer controls | provider |
| `session history/resume/fork` | `session.history/resume/fork` | resumable sessions; fork adopts into a new tab | provider |
| `session interactions list/resolve` | `session.interactions`, `session.interaction.resolve` | pending interactions, `resolve_native_agent_interaction` | provider |
| `session transcript` | `session.transcript` | transcript window + message pages | read (content) |
| `run get/wait` | `run.get` | operation store + reconciler | read |
| `run retry/discard` | `run.retry/discard` | `retry/discard_native_agent_dispatch` | provider |
| `run cancel/output` | `run.cancel/output` | exec worker control | process / read |
| `run receipts` | local | private local receipts | none |

The shared discovery, tab resolution, catalogue and launch-validation helpers
live in [`control-shared-actions.ts`](../../apps/backend/src/core/control-shared-actions.ts)
and are used by both Control MCP and the public actions. Control MCP keeps its
own result formatting, annotations and coordinator scope; an operator request
cannot assert coordinator fields.

Paths passed to project commands are on the **backend** host. Prompt, patch,
stdin and credential files are read on the machine running the client.

## Request keys and receipts

Every mutation carries a request key. `--request-id KEY` sets it; otherwise the
client generates one. Before the request leaves the process the client writes a
private local receipt (action, key, namespace, installation, intent digest — no
payload). A local receipt records intent, not acceptance, and is never
resubmitted automatically. `orkestrator run receipts` lists them.

In the backend the key is scoped by authority, action, target scope and
request ID, and bound to a SHA-256 fingerprint of the canonical intent. The
admission check, key reservation and record publication happen in one critical
section (cross-process lock) **before** any side effect; if publication fails,
nothing runs.

- Same key, same intent → the original operation (`replayed: true`), whatever
  its state. A deleted resource is never recreated by a replay.
- Same key, different intent → `request-conflict` (exit 8).
- Control MCP `launch_environment` passes its own fingerprint to
  `create_environment`, so both transports share one conflict rule. Records
  created before fingerprints existed keep converging (legacy recovery).

Operations persist their resource IDs as soon as they are known, their stage,
dispatch and execution state, and a small content-free result. `run get OP`
or `run get --request-id KEY --action ACTION` reads them;
`not-found` and `history-expired` are distinct and neither is evidence that
nothing ran.

### Retention and expiry

Keys belong to a **namespace** (`ns-<created ms>-<random>`), published in
`capabilities.requestKeys`. A namespace admits new keys for 7 days; its records
are retained until its fence (created + 7 + 30 days) and longer while any of
its operations is active (a permanently `unknown` record with nothing left to
recover no longer pins it past the fence). After the fence the namespace is
retired: its files are deleted and any request or lookup naming it is refused
with `namespace-expired` / `history-expired`, never re-executed. Limits: 5,000
records and 16 MiB per namespace, 8 KiB per record; a full namespace refuses
new work (`store-capacity`) rather than evicting history. A corrupted store
refuses admission instead of being treated as empty. Durability is the atomic
temp-file + rename (+ fsync) the other stores use: a process crash or kill,
not a claim of power-loss durability.

### After a restart

A reconciler (startup pass, environment change events, 15 s sweep, and every
`run get`) settles active operations from authoritative state:

| Operation in flight | After a backend restart |
| --- | --- |
| `admitted` (nothing ran) | Runs once when its key is replayed; closed as interrupted after a day otherwise |
| create | Settled from the environment carrying its control request ID, else interrupted |
| start / recreate in setup | Settled from setup state (ready → succeeded, failed → failed) |
| start not yet running, stop, other in-flight | `interrupted` — the effect is not confirmed and nothing re-runs |
| delete | Succeeds when the environment is gone; keeps observing a re-admitted deletion |
| prompt runs | Request-specific observation (below); unknown dispatch stays parked |
| exec | The worker survives; its recorded exit status settles the run |

## Environments

`running` means processes run; **ready** means running with setup complete (or
explicitly overridden, reported as such — the CLI never overrides setup).

```bash
ENV=$(orkestrator environment create --project "$PROJECT" --type local \
  --base-branch main --base-commit "$SHA" --request-id "$ID:create" --output id)
orkestrator environment start "$ENV" --wait ready --timeout 10m --json
```

`--wait` conditions (`running`, `ready`, `stopped`, `deleted`) first require
the operation itself to finish successfully, so an earlier unrelated
transition never satisfies a wait; setup failure fails the wait with the
recorded reason (exit 1). A start operation stays `running` through setup and
completes when setup is ready or failed. `--timeout` and Ctrl+C stop observing
only; the printed receipt resumes with `run wait`.

An explicit base must be a branch plus a full 40-character commit contained in
it; container bases must be published to a remote. The commit actually used is
reported as `base.commit`. `recreate` (containers only) and `delete` are
destructive and say so in help. Deletion is tracked through cleanup; a failed
cleanup stays inspectable. Stop, recreate and delete first cancel the
environment's running exec commands.

## Settings

`project config` and `environment config` edit typed keys only (schema:
`PUBLIC_PROJECT_SETTINGS`, `PUBLIC_ENVIRONMENT_SETTINGS`): repository branch
defaults, port mappings, files to copy, entry port, allowed domains, and the
agent defaults (`agent.defaultAgent`, `agent.<platform>.mode|model|reasoningEffort|fastMode`).
Credentials are never settable here.

`get` reports the stored value, the effective value, its source tier
(environment → repository → global → default) and when it applies
(`next-environment`, `next-start`, `next-session`, `applied`). `set` accepts
`--set key=value` (JSON-parsed when possible), `--unset key`, or a JSON patch
file `{"set": {...}, "unset": [...]}`; `null` is refused (use unset). The
backend applies the patch atomically under the owning lock and a content
revision (`--expected-revision`); UI writes change the same revision, so stale
edits conflict. Launch intent (initial prompt, attachments, pending selection)
is never touched. Editing environment agent defaults never reconfigures a live
conversation — `session config set` does that.

## Sessions and runs

A public session ID (`ses_…`) is derived from the environment and tab, so it
survives provider resumes. Sessions are resolved from the backend's pane
layout, never from whichever tab a desktop shows; a closed tab is `not-found`,
never replaced.

- `session start` creates an independent conversation in its own tab (not
  focused) and sends one first prompt. `session prompt` continues an **idle**
  session; a busy one is refused (`busy`, exit 8) — use `session steer` where
  supported. Prompt text comes from `--prompt-file`, `--prompt-stdin` or
  `--prompt` (mutually exclusive; UTF-8; 100,000 characters / 400,000 bytes).
- `environment launch` is one backend-owned flow: create, start, setup, then
  exactly one initial prompt under the stable request ID
  `initial-prompt:<environment>:startup-agent`. Setup failure leaves the prompt
  unsent (`partial`, `dispatch: not-sent`). Never follow it with `session start`.
- Responses mean **submitted**. The receipt's `dispatch` is
  `accepted | rejected | unknown`; `execution` is
  `pending | running | waiting-for-input | completed | failed | cancelled | interrupted | unknown | unsupported`.

### Request-specific completion

A run is identified by its dispatch request ID (the operation ID). It settles
only on evidence about that request: the dispatch journal, the backend's own
observation of that session's turn activity, and the per-request turn outcome
record (with one provider status read when the turn has visibly ended,
coalesced across concurrent waiters). An idle environment, another tab's
completion, a dropped client or the agent's wording are never evidence. A
later steering input does not end a turn while the session is busy. Missing
evidence stays `unknown`. A provider whose status reads idle after a failed
turn (OpenCode keeps the error on the request's last assistant message) is
asked for that request's terminal error before an idle turn counts as
completed; an unreadable answer is retried, never settled as success.

| Provider | Completion | Evidence (packaged CLI, file assertion + follow-up) |
| --- | --- | --- |
| Claude | qualified | live runs in local and container environments |
| Codex | qualified | live runs in local and container environments (explicit model from a refreshed catalogue) |
| OpenCode | qualified | live runs in local and container environments with a connected model; a failed turn settles as failed |
| Pi, Cursor, Grok | unqualified | not yet live-qualified through the CLI; runs end `unknown`/`unsupported` instead of claiming completion |

`run wait OP` exits 0 only on success; 6 when an interaction needs an answer
(add `--continue-on-interaction` to keep waiting for another client to answer);
7 for unknown dispatch/outcome; 5 at its own deadline; 1 on failure. Only
`pending` interactions count, and an answer from any client clears the cached
read, so a question that was just answered does not report 6.

- **Unknown dispatch** parks the session: other prompts are refused
  (`dispatch-parked`) until `run retry OP` (replays the stored prompt verbatim
  under the same key) or `run discard OP` (clears recovery; does **not** undo a
  turn that may have run — the run ends `interrupted`).
- **Stop** targets the session's current turn (`--expect-run OP` refuses if a
  newer turn started). It succeeds only when the provider confirms the turn
  ended; otherwise `run-unknown`. A stopped run settles as `cancelled`.
  Stopping a turn differs from stopping the environment.
- **Interactions**: `session interactions list` shows pending questions and
  approvals with their options, revision and allowed actions; `resolve`
  requires `--revision` to match and validates the answer against the
  interaction before anything reaches the provider. Stale, replaced, expired or
  malformed answers are refused and never approve; the same answer key does
  not answer twice. A CLI exiting never answers an interaction.

### Transcripts

`session transcript SESSION [--limit N] [--before CURSOR]` returns an
oldest-first page (≤ 100 messages, ≤ 1 MiB, message text ≤ 20,000 characters
with `textTruncated`). Tool inputs and outputs are never inlined
(`detailOmitted`). `olderCursor` pages back through the live window and then
the provider history; a cursor that no longer lines up is `cursor-expired`.
Missing, unavailable and empty are distinct. `--follow --jsonl` polls pages and
emits each new message once, with a `gap` record when more arrived than one
page holds; it stops at `--timeout` or Ctrl+C and never affects the session.
Transcript reads are explicit content access; status reads and waits never
read transcripts.

## Exec

```bash
orkestrator environment exec "$ENV" --wait -- bun test ./src/thing.test.ts
orkestrator environment exec "$ENV" --wait --exit-code -- sh -c 'make check'
```

Arguments after `--` are passed as argv without a shell (use `sh -c` to opt
in). A worker in the environment — on the host for local environments, inside
the container otherwise — owns the command in its own process group, writes
stdout and stderr to separate private files (16 MiB each; beyond that the
command is stopped and `outputLimited`), enforces `--exec-timeout` (default
30 m, max 6 h), and records the exit code or signal before completion is
reported. `cwd` is relative to the workspace and symlink-confined. Environment
names starting `ORKESTRATOR_` are reserved and removed from the command's
environment. At most four commands run per environment.

The worker outlives the client and the backend; a backend restart reconciles
it by its heartbeat (a recycled PID cannot impersonate it). A worker that stops
reporting is `interrupted` and never re-run. `run cancel OP` targets that exact
worker and drains its descendants. `run output OP [--stream stderr] [--tail N]`
reads a bounded window. By default a non-zero exit is exit 1 with the child's
code in JSON; `--exit-code` passes the child's code through (the envelope stays
`ok: true`, which is how a script tells it apart from a client failure).

## Targeted scenarios

`mise run test:cli:scenarios` builds the package and runs scenarios against
isolated backends started through the packaged launcher (disposable data and
worktree roots, argv-only driver, owned cleanup, private manifest under
`output/cli-scenarios/<run>/`). Credential-free by default:
`read-only`, `local-lifecycle`, `retry-and-retention`, `setup-failure`,
`client-exit`, `exec`, `wrong-profile`. Options: `--scenario NAME` (repeat),
`--list`, `--keep-on-failure`, `--environment-type container
--docker-image TAG` (a worktree-owned image from `mise run docker:build:dev`;
the shared `latest` tag is refused), and `--provider NAME` for the
credentialed `live-session` scenario (`ORKESTRATOR_SCENARIO_MODEL` pins a
model). Fixture origins sit at `<scenario root>/fixtures/origin.git`, the one
remote the agent-test runtime mounts into containers. Container live runs for
providers other than Claude use `--network full`, because the default
restricted allowlist reaches only Anthropic's API. Live runs use host credentials
(`--credential-source`) and cost real tokens; keep them opt-in. The published
package ships only the Claude and Codex bridges (OpenCode runs its own server),
so Pi, Cursor and Grok need a full development profile.

## Limitations and rollout

- Not provided: local-only project initialization, cascade project removal,
  prompt attachments, selected slash commands, durable enqueue, declarative
  apply, shell completion, worker-scoped credentials. `capabilities.features`
  reports these as unavailable.
- Container lifecycle and exec are qualified on Linux Docker with a
  worktree-owned image; macOS Docker Desktop has not been run.
- Browser-checked in `e2e/agent-testing/cli-ui.spec.ts`: CLI-made project,
  environment and settings changes reach an open and a reloaded renderer;
  with a live Claude profile, a CLI-started question rehydrates in an
  inactive, reloaded renderer and the UI's answer completes the CLI's run.
  Other providers' question cards were not browser-checked.
- To withdraw one action, remove its handler from
  [`registry.ts`](../../apps/backend/src/core/public-api/registry.ts):
  capabilities stop advertising it and clients refuse it before submitting,
  while `run.*`, the reconciler and the operation store keep serving already
  accepted work. Never delete `public-operations/` when withdrawing a feature.
