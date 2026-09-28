# Testing with the `orkestrator` CLI

Status: Living — how agents drive a running Orkestrator through its client
commands while testing a change.

The `orkestrator` client commands control projects, environments, settings,
agent sessions, interactions, transcripts and in-environment commands without
touching the UI. Use them to set up state for browser QA, to exercise backend
behavior directly, and to check what the UI should show after a reload.

This guide covers the testing workflow only. The contract (backend selection,
envelope, exit codes, request keys, retention, completion rules) lives in
[`public-cli.md`](../architecture/public-cli.md); profiles and browser QA live
in [`agent-testing.md`](agent-testing.md).

## Safety rules

- Point the CLI only at an isolated `dev:test` profile you own, with
  `--profile NAME`. Never save a connection to, or set a default for, a
  production Orkestrator while testing.
- Client commands never start a backend. Start the profile first; the CLI
  attaches to it or fails with exit 4.
- Work only on the profile's `testProject`, which `--fixture` registers as a
  project. Never `project add` this Orkestrator checkout.
- Keep receipts out of the user's real CLI configuration: set
  `ORKESTRATOR_CLI_CONFIG_DIR` to a directory of your own for the run.
- `environment delete` and `environment recreate --discard` are destructive.
  Use them only on environments your test created. `recreate` without
  `--discard` is a preserving rebuild: it keeps the files, but it still stops
  and replaces the container.
- Live sessions send real prompts and cost real tokens. Keep prompts small and
  scoped to the fixture.

## Setup

Build the client from the worktree, then start a profile in a long-lived
session (it stays attached):

```bash
mise run build:cli
mise run dev:test --profile cli-qa --fixture
```

In another session, wait until `mise run dev:status --profile cli-qa --json`
reports `status: "ready"`. Then define a helper so every call uses the
worktree build, the profile, and a private config directory:

```bash
export ORKESTRATOR_CLI_CONFIG_DIR="$(mktemp -d)/orkestrator-cli"
ork() { bun packages/cli/bin/orkestrator.js --profile cli-qa "$@"; }

ork connection check   # installation, version, advertised actions
```

Pass arguments as separate words. In zsh, an unquoted `$VAR` holding
`--profile cli-qa` stays one argument and is rejected with exit 2; the
function above avoids this.

After backend or CLI source changes, rebuild with `mise run build:cli` and
restart the profile (see agent-testing.md). The client reads `dist/`, so a
stale build tests stale code.

For a credential-free run add `--no-agent-credentials` to `dev:test`. Project,
environment, settings and exec commands all work without credentials. Session
commands need a provider, for example `--credential-source claude
--agent-platforms claude`.

## Reading output in scripts

| Need | Use |
| --- | --- |
| One ID to pass to the next command | `--output id` |
| Structured fields | `--json`, then `jq` on the envelope |
| A pass/fail decision | The exit status, never the human text |

```bash
PROJECT=$(ork project list --output id)       # the fixture project
ork environment get "$ENV" --json | jq '.result | {status, ready, setup, activity}'
```

The envelope is `{ok, action, result | error, receipt?}`. Mutations return a
`receipt` with `operationId`, `state`, `dispatch` and `execution`. Read
`error.code` rather than matching messages. The exit classes are listed in
[public-cli.md](../architecture/public-cli.md#output-and-exit-codes). Tests
most often check: 0 ok, 1 failed, 3 not found, 5 wait deadline, 6 interaction
needed, 7 unknown outcome, 8 conflict or busy.

Human output is for reading only and may change between releases.

## Recipes

### Environment lifecycle

```bash
ENV=$(ork environment create --project "$PROJECT" --type local \
  --name cli-qa-env --request-id cli-qa:create --output id)
ork environment start "$ENV" --wait ready --timeout 10m
ork environment get "$ENV"
ork environment stop "$ENV" --wait stopped
ork environment delete "$ENV" --wait deleted
```

`--wait ready` exits 0 only after setup completes, and exits 1 with the recorded
reason if setup fails. `--timeout` stops observing but not the operation;
resume with `ork run wait OP`.

Use `--type container` for Docker environments. It needs the profile's image
(see agent-testing.md), and an explicit `--base-branch`/`--base-commit` must
already be pushed to a remote.

### Running commands inside an environment

```bash
ork environment exec "$ENV" --wait --exit-code -- sh -c 'git status --short && bun test'
```

Everything after `--` is argv with no shell; use `sh -c` for pipes or `&&`.
`--exit-code` makes the CLI exit with the child's status. Without it a
non-zero child exits 1. To read output separately or keep the command running
in the background:

```bash
OP=$(ork environment exec "$ENV" --output id -- bun test)
ork run wait "$OP"
ork run output "$OP"                   # stdout
ork run output "$OP" --stream stderr --tail 4096
ork run cancel "$OP"                   # if it must be stopped
```

This is the reliable way to check an agent's file changes: after a run,
`exec -- cat path` or `exec -- git diff --stat` reads the environment's real
workspace.

### Settings

```bash
ork project config get "$PROJECT"
ork environment config get "$ENV"      # value, effective value, source, when it applies
ork environment config set "$ENV" --set agent.defaultAgent=codex --set agent.codex.model=gpt-5.4
ork environment config unset "$ENV" agent.defaultAgent
```

`config set --help` lists every settable key. Use `--expected-revision REV`
(from `get`) to test concurrent-edit conflicts; a stale revision exits 8.

### Agents and sessions

```bash
ork agent options --environment "$ENV"      # enabled agents, models, completion qualification
```

Start a session and wait for its turn. `--json` gives both IDs:

```bash
OUT=$(ork session start --environment "$ENV" --agent claude \
  --prompt 'Create hello.txt containing hi. Do nothing else.' \
  --wait --timeout 5m --request-id cli-qa:start --json)
SESSION=$(jq -r '.result.sessionId' <<<"$OUT")
RUN=$(jq -r '.receipt.operationId' <<<"$OUT")

ork session list --environment "$ENV"
ork session get "$SESSION"
ork session prompt "$SESSION" --prompt 'Now delete it.' --wait
ork session transcript "$SESSION" --limit 20
```

- Send long prompts with `--prompt-file`, not `--prompt`.
- `session prompt` against a busy session exits 8. Use `session steer` (on
  providers that support it) or wait for the turn to end.
- `session stop SESSION` stops the current turn, not the environment.
- `environment launch` does create, start and first prompt in one call. Do
  not follow it with `session start`.
- Only Claude, Codex and OpenCode report completion. Pi, Cursor and Grok runs
  end `unknown` or `unsupported`, so a test on those providers must check the
  outcome another way (for example with `exec`).

### Questions and approvals

A waited run that needs an answer exits 6. To answer from the CLI:

```bash
ork session interactions list "$SESSION"   # IDs, revision, options, allowed actions
ork session interactions resolve "$SESSION" "$INTERACTION" \
  --revision 3 --action answer --choose q1=option-a
ork run wait "$RUN"
```

To test that the UI answers a question the CLI started, wait with
`--continue-on-interaction` and answer it in the browser.

### Watching progress

```bash
ork session transcript "$SESSION" --follow --jsonl --timeout 2m
ork run get "$RUN"
ork run get --request-id cli-qa:start --action session.start
```

## Using the CLI in UI testing

- **Set up state quickly.** Create and start environments, change settings or
  start sessions with the CLI, then check the result in the browser at the
  profile's `browserUrl`.
- **Test rehydration.** Start work from the CLI while the browser shows a
  different environment or tab. Switch back, then reload, and check that the
  status, transcript and pending interactions match `ork session get` and
  `ork environment get`. This covers the inactive path from AGENTS.md without
  keeping a component mounted.
- **Check idempotency and conflicts.** Repeat a mutation with the same
  `--request-id` (the result is `replayed: true`, not a second resource), then
  with the same key and different arguments (exit 8, `request-conflict`).
- **Test error paths.** Unknown IDs exit 3, busy sessions exit 8, and a
  `--timeout` shorter than the operation exits 5.

`e2e/agent-testing/cli-ui.spec.ts` automates the CLI→UI checks. The packaged
CLI scenarios (`mise run test:cli:scenarios`) test the CLI itself against
disposable backends; see [testing-guide.md](testing-guide.md#cli-scenarios).

## Cleanup

Delete the environments your test created (`ork environment delete ENV --wait
deleted`), then stop and reset the profile as described in
[agent-testing.md](agent-testing.md). Remove the temporary
`ORKESTRATOR_CLI_CONFIG_DIR`. Report the commands you ran and their exit
statuses along with the rest of your test evidence.
