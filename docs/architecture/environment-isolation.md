# Environment isolation for local environments

Status: Living — added 2026-11-17 for the self-improvement theme
`insight:review-env-unprovisioned-and-unisolated`.

A container environment has its own network namespace and no Docker daemon,
so nothing it starts can meet another environment's services. A local
environment is a worktree on the host: it shares the host's ports, its Docker
daemon and Docker Compose's project namespace with every other worktree of the
same project.

That sharing broke review validation in practice. A repository whose compose
file fixes `name: my-stack` and publishes `127.0.0.1:5433:5432` makes every
worktree's `docker compose up` address the same containers. One environment's
migrations ran against another session's database, and a second environment's
services failed with "port is already allocated", so DB-backed and runtime
suites failed before they tested the change.

## What each local environment gets

`environments/isolation.ts` (backend) gives every local environment:

| Variable | Value |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | `ork-` and the first twelve alphanumerics of the environment id, lowercased |
| `ORKESTRATOR_PORT_BASE` | First port of a block of host ports reserved for this environment alone |
| `ORKESTRATOR_PORT_COUNT` | `20` |
| `ORKESTRATOR_PORT_MAX` | Last port of the block (`BASE + 19`) |
| `ORKESTRATOR_ENVIRONMENT_ID` | The environment id, for naming other per-environment resources |

Compose gives `COMPOSE_PROJECT_NAME` precedence over a compose file's
top-level `name:`, so containers, networks and volumes become the
environment's own without any change to the repository. The project name is
derived from the id, not the display name, so renaming an environment does not
orphan its running containers.

Ports are a different matter: Compose has no way to move a published port on
its own. The block is reserved so a repository can map its services onto it,
for example `ports: ["127.0.0.1:${ORKESTRATOR_PORT_BASE:-5433}:5432"]`, or
a `setupLocal` step that writes `DB_PORT=$ORKESTRATOR_PORT_BASE` into a
`.env` it derives from `.env.example`. A repository that keeps fixed ports
still collides; the variables make the fix a small change in the repository.

## The port block

Blocks come from 20000–31999 in steps of 20 (600 blocks): above the common
development defaults (3000, 5173, 5432, 8080) and below the ephemeral ranges
the OS uses for outgoing connections (Linux from 32768, macOS from 49152).

The block is reserved on first use and kept on the environment record as
`isolationPortBase` (backend-private; `toClientEnvironment` strips it).
`EnvironmentIsolationRepository.assignEnvironmentPortBase`
(`storage/environment-isolation.ts`) chooses and writes it under the
environment store's lease, the lease every environment write holds, so two
environments starting at once cannot be handed the same block, and a restart
keeps the same ports. Deleting the environment deletes the record. Before
assigning a block to another environment, the allocator tries binding every
port on IPv4 and IPv6 wildcard and local interface addresses, under the same
store lease. It skips
a block if any port is occupied, including by a deleted environment's leftover
services. Probe sockets are closed before returning. Existing reservations are
kept without probing because the environment's own services may hold them.

The search starts at a block derived from a hash of the environment id rather
than the lowest free one. Hashing spreads allocations; it does not establish
availability. A block two records share (a copied row) is given up by the
first of them to ask.

The reservation is per backend, that is per machine. An unrelated program can
still race to bind a port after the probe; repository tasks must handle bind
failures. Orkestrator does not stop leftover Compose services on deletion.

A failed or exhausted reservation never fails a launch: the process starts
without the port variables but still with its own Compose project name, and
the backend logs `environment` `isolation.port-block-unavailable`.

## Where the variables apply

Every process Orkestrator starts in a local environment's worktree:

- the setup terminal (`setupLocal`), whose intro prints the project name and
  the port range;
- terminal tabs;
- user commands run in the worktree;
- local Claude tmux sessions, with values exported in each pane rather than
  changing the shared tmux server;
- the agent bridges (Claude, Codex, OpenCode, Cursor, Grok, Pi), so an
  agent's shell commands inherit them;
- review validation: the worker that runs a review's planned commands
  (`review/validation-service.ts`), so a suite started during review
  preparation uses the environment's own services.

A coordinator conversation (which works in the project checkout) and a bug
report (a scratch directory) are not environments and get none of them; their
launches drop any copy inherited from the backend's own environment. Every
launch replaces all five isolation variables before applying the target values,
including when allocation fails; stale port values cannot survive that fallback.

Not covered: `orkestrator exec` through the public CLI, whose worker removes
every `ORKESTRATOR_*` variable from the command's environment by design, and
container environments, which need none of this.

## Provisioning before review validation

Review preparation's discovery prompt
(`REVIEW_VALIDATION_DISCOVERY_PROVISIONING_GUIDANCE` in
`packages/protocol/src/review-evidence-frames.ts`, see
[review-preparation.md](review-preparation.md)) asks the planner to provision
what the selected suites need as earlier plan commands they depend on: build
artifacts a suite reads but does not build (a web bundle a browser test
serves), a repository-owned task that creates a missing local environment file
from its committed example, and repository-owned one-shot tasks that start a
throwaway service such as a test database. It must never point a suite at a
service another workspace may use, must keep services inside the reserved port
range, treats a service that can only bind a fixed host port as the
host-shared resource `host:tcp:<port>`, and names a secret or credential the
workspace lacks in a limitation.

The prompt that writes a project's `orkestrator-ai.json`
(`packages/protocol/src/orkestrator-script-prompt.ts`) gives the same
guidance for `setupLocal`: create a local environment file from the committed
example only when none exists, and set the port variables a project reads to
ports in the reserved range.

## What a project still has to do

Orkestrator cannot invent a working `DATABASE_URL` or a secret for an
arbitrary repository. The project's part:

- Read published host ports from variables (with today's ports as defaults)
  rather than fixing them in compose files and scripts.
- Provide a `setupLocal` (or a task review validation can call) that derives a
  development `.env` from `.env.example` with ports from
  `$ORKESTRATOR_PORT_BASE`, generating development-only secrets locally.
- Offer standalone one-shot tasks for suites that need a throwaway database,
  so validation can schedule them without hand-building one.

The Environment files setting (`envFilePatterns`) still copies a `.env` from
the project checkout into each new worktree; a copied file with fixed ports
still collides, so the derived file is the one to prefer.

## Verification

Backend launch tests cover inherited-value replacement for setup, terminals,
user commands, bridges, coordinator and bug-report runtimes, and review workers.
The worker tests exercise both successful and failed reservations and verify that
status and cancel do not allocate blocks.

`environments/isolation.integration.test.ts` keeps a listener alive after deleting
its environment, then allocates an id with the same hash start. It also checks
IPv6-only occupancy and reuse after the listener stops.
`tmux/environment-isolation.integration.test.ts` launches two fixture Claude
processes through the real session launcher on one private tmux server, checks
both child environments, and confirms the server's values are unchanged.

The opt-in Compose smoke test needs Docker Compose, a locally available
`postgres:17-alpine` image and the `psql` client. It creates two temporary Git
worktrees, derives their local environment files and fixture build artifacts,
starts separate databases with interpolated host ports, and checks independent
markers through those ports. Stopping one stack must leave the other usable.
It removes only its own Compose resources and temporary storage:

```bash
ORKESTRATOR_ISOLATION_COMPOSE_SMOKE=1 mise run test:logged -- --name isolation-compose -- \
  bun test --cwd apps/backend ./src/core/environments/isolation-compose.integration.test.ts \
  --parallel=1 --only-failures
```
