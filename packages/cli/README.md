# Orkestrator backend and client

The `orkestrator` executable has two modes:

- **Service** — `orkestrator`, `orkestrator serve …`, or the historical
  `orkestrator --host … --port …` forms run the backend in the foreground.
- **Client** — `orkestrator <group> <command> …` talks to a backend that is
  already running. Client commands never start a backend.

Run the Orkestrator backend service without installing the desktop application:

```bash
bunx orkestrator
```

The service stays in the foreground and stops cleanly when it receives Ctrl-C,
SIGINT, or SIGTERM. It stores persistent state in the normal Orkestrator data
directory.

For the hosted web client, publish the backend through Tailscale Serve and allow
the Orkestrator origins:

```bash
bunx orkestrator \
  --tailscale-serve \
  --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev
```

For a loopback-only service:

```bash
bunx orkestrator \
  --host 127.0.0.1 \
  --port 34121 \
  --allow-non-tailscale-bind
```

Or install Bun when needed and start the service in one command:

```bash
curl -fsSL https://orkestrator.dev/install.sh | bash
```

Pass backend arguments through the installer with `bash -s --`:

```bash
curl -fsSL https://orkestrator.dev/install.sh | \
  bash -s -- --tailscale-serve \
  --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev
```

macOS and Linux are supported. Docker is required for container environments;
Tailscale is required only for tailnet access and Tailscale Serve.

## Client commands

Select the backend explicitly. A running backend publishes a private
`backend-instance.json` in its data directory; save it once as the default:

```bash
orkestrator connection add local --data-dir "$HOME/.config/orkestrator-v2" --default
orkestrator connection check
```

Remote backends use a private token file or stdin — never a token argument:

```bash
orkestrator connection add laptop --url https://laptop.example.ts.net --credential-file ~/.secrets/token
```

A complete, owned workflow (IDs and request keys are explicit so a script can
recover after a lost response or restart):

```bash
set -euo pipefail
PROJECT=$(orkestrator project add --path /srv/repos/app --request-id "$RUN:add" --output id)
ENV=$(orkestrator environment create --project "$PROJECT" --type local \
  --name "$RUN" --request-id "$RUN:create" --output id)
trap 'orkestrator environment delete "$ENV" --wait deleted --timeout 5m --json >/dev/null' EXIT
orkestrator environment start "$ENV" --wait ready --timeout 10m --json
orkestrator environment config set "$ENV" --set agent.claude.model=opus
orkestrator session start --environment "$ENV" --agent claude \
  --prompt-file task.txt --request-id "$RUN:prompt" --json > launch.json
RUN_ID=$(jq -er '.result.runId' launch.json)
SESSION=$(jq -er '.result.sessionId' launch.json)
orkestrator run wait "$RUN_ID" --timeout 30m --json
orkestrator session transcript "$SESSION" --limit 20 --json > transcript.json
orkestrator environment exec "$ENV" --wait -- bun test
```

- `--json` prints exactly one envelope on stdout; `--output id` prints only
  the documented ID. Exit codes: 0 ok, 1 failed, 2 invalid input, 3 not
  found/ambiguous/expired, 4 connection/auth, 5 observer deadline,
  6 interaction required, 7 unknown dispatch/outcome, 8 conflict/unsupported,
  130/143 observation interrupted.
- Paths given to `project` commands are on the backend host; prompt, patch and
  credential files are read locally.
- `project create` creates a **private GitHub repository** and pushes to it;
  it requires `--github-private`.
- A timeout or Ctrl+C only stops observing. Resume with `orkestrator run wait
  OP`; recover a lost response with `orkestrator run get --request-id KEY
  --action ACTION`. The client never resubmits under a new key.

Run `orkestrator help` and `orkestrator help <group> <command>` for the full
command reference. The contract, retention rules and provider completion
matrix are documented in the repository's `docs/architecture/public-cli.md`.

## Publishing

`dependencies` here lists only the modules `scripts/build.ts` leaves unbundled;
everything else is inlined into `dist/` and `resources/`. `tests/cli.test.ts`
derives that list from the built artifacts, so adding a dependency the bundles do
not resolve — or bumping one in `apps/backend` or `bridges/` without mirroring it
here — fails the suite.

Publish from the repository root:

```bash
mise run publish:cli
```

That runs `smoke:cli` first, which packs the tarball, installs it into a scratch
project, checks the unbundled dependencies resolve from the installed layout,
runs client help/version/errors with no backend, starts the backend, drives a
fixture project/environment lifecycle through the installed client, confirms
only one backend ran, and stops it. It needs network access, which is why it is
a publish gate rather than part of `mise run test`.

`dist/client.js` is the client bundle the launcher imports first; it must stay
free of backend imports so client commands never initialize a service.
