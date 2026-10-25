# OpenCode 2.x migration

Checked against `main` at `2459b05c` (2026-10-15).

This is the deferred checkpoint for moving from the OpenCode 1.x line to
OpenCode 2.x. The decision is still: do not bump the OpenCode binary or SDK to
2.x. A 2.x server has no legacy HTTP API, so the move is a rewrite of the
backend OpenCode provider rather than a version bump. Upstream evidence was
last refreshed on 2026-09-27 against OpenCode `v2.0.18`. The 1.x line was
rechecked at `1.19.0` on 2026-10-11/13 (#964) and moved to `1.19.4` on
2026-10-23.

Three different things are called "v2" around OpenCode. The file name is kept
for existing links, but the text says "2.x" and never a bare "v2":

- **OpenCode 2.x** is the product line this file is about. It lives on upstream
  branch `v2`, ships under the new `@opencode/*` npm scope, and its server
  serves only `/api/*`.
- **`@opencode-ai/sdk/v2/client`** is the import path that `AGENTS.md`
  ("OpenCode SDK v2 - CRITICAL") requires. It is the current generated client
  of the 1.x SDK, and it drives the 1.x server. Sixteen backend files import it.
  That rule is correct and unaffected by anything here; "SDK v2" there does not
  mean OpenCode 2.x.
- **Session V2** is the experimental session protocol inside 1.x
  (`client.v2.*`, `session.next.*` events). It is what shipped as OpenCode 2.0.
  The repository has zero `client.v2.*` call sites.

## Current state

- Pin: `1.19.4` for `@opencode-ai/sdk` (`apps/backend/package.json`) and the
  CLI (`PINNED_TOOLCHAIN_VERSIONS.opencode` in
  `packages/toolchain/src/manifest.ts`, `OPENCODE_CLI_VERSION` in
  `docker/Dockerfile`). `tests/unit/version-drift.test.ts` keeps them in step.
  The SDK carries a patch (`patches/@opencode-ai%2Fsdk@1.19.4.patch`, the
  generated SSE client's unhandled `reader.cancel()` rejection).
- No `@opencode/*` dependency. `session.next.*` events are listed in
  `KNOWN_OPENCODE_EVENTS` (`apps/backend/src/core/opencode-events.ts`) as
  known but unhandled.
- Every OpenCode process Orkestrator starts carries
  `OPENCODE_PINNED_RUNTIME_ENV` (`OPENCODE_DISABLE_AUTOUPDATE=1`,
  `packages/protocol/src/terminal-agent-launch.ts`). That covers terminal tabs,
  `opencode serve` (`commands-servers.ts`) and the model catalogue refresh. The
  container image sets the same `ENV`. The 1.19 TUI otherwise offers to install
  OpenCode 2 in place from `/update`.
- `checkHttpHealth` (`apps/backend/src/core/commands-server-health.ts`) still
  defaults to `GET /global/health` and treats any 2xx as healthy. See the hazard
  below.
- Containers point `OPENCODE_DB` at `OPENCODE_DB_PATH`
  (`container-state-layout.ts`) when the persistent state mount exists. The
  host uses OpenCode's default `~/.local/share/opencode/opencode.db`.
- `mise run verify:opencode:live` runs the live 1.x compatibility and
  review-permission tests. They start `opencode serve --pure`, which 2.x
  removed.
- Upstream at the last checkpoint:
  - 2.0.0 shipped on 2026-09-11 and 2.0.18 on 2026-09-25.
  - The 1.x line still gets releases and fixes, now cut from upstream's `v1`
    branch (1.19.0 on 2026-10-11). No end-of-life notice for 1.x was found.
  - 2.x packages: `@opencode/cli`, `@opencode/client`, `@opencode/sdk`,
    `@opencode/server`, `@opencode/protocol`. 2.x has git tags but no GitHub
    Releases; binaries ship only as `@opencode/cli-<platform>` npm packages.
  - Upstream treats `opencode upgrade --major` as the official 1.x → 2.x route.

### Why a binary-only bump fails

Verified live on 2026-09-27 with `@opencode/cli@2.0.18` in an isolated
HOME/XDG and `@opencode-ai/sdk@1.18.32`:

| Call (1.18.32 SDK / our raw HTTP) | 2.0.18 result |
| --- | --- |
| `client.session.list`, `client.global.health`, `client.config.get` | throws `Request is not supported by this version of OpenCode Server (Server responded with text/html)` |
| `client.session.create` | `405` |
| raw `GET /global/health`, `/session`, `/config`, `/provider`, `/mcp` | `200 text/html`: the bundled web app's SPA fallback, served before auth |
| raw `POST /mcp` (`configureOpenCodeAgentTools`) | `405` |
| `client.v2.session.list` | `200` JSON, but 11 of the old SDK's 51 `/api` routes no longer exist on 2.x (questions → forms, per-session `history`/`event`, `wait`, `revert/clear`, `/api/health`) |

Upstream removed the legacy routes rather than deprecating them. The server
route table registers only `/api/...` (plus `/auth/connect/:code` and
`/openapi.json`), `packages/opencode` (the 1.x runtime) no longer exists on
`v2`, and `packages/server/src/options.ts` has no legacy toggle.

Hazard: because `checkHttpHealth` accepts any 2xx on `/global/health`, a
binary-only bump would report the server healthy and then fail every session
call. Any pin change must move the probe to `GET /api/info` and reject HTML.

The only way to run both is two binaries: 1.x for legacy sessions and 2.x for
new ones, each with its own data directory or `OPENCODE_DB`.

### API mapping (`/openapi.json`, 2.0.18)

| 1.x (what the provider calls) | 2.x |
| --- | --- |
| `GET /global/health` | `GET /api/info` (`{version,pid,urls,paths}`) |
| `session.promptAsync` / `message` | `POST /api/session/:id/prompt` (`delivery: steer \| queue`, `resume`, idempotent input ID) |
| `session.abort` | `POST /api/session/:id/interrupt` |
| `session.summarize` | `POST /api/session/:id/compact` |
| `session.revert` / `unrevert` | `revert/stage`, `revert/commit`, `DELETE revert` |
| `session.command` | `POST /api/session/:id/command` (field `command` → `name`) |
| `session.fork`, `delete`, `update`, `diff`, `messages` | `fork` (optional `before`), `DELETE`, `PATCH`, `diff`, `message` list/get |
| `question.*` | `session.form.*` / `GET /api/form` |
| `permission.list` / `reply` | `session.permission.*` (`reply` → `decision`), `GET /api/permission/request` |
| `mcp.status` / `add` / `connect` / `disconnect` | `GET /api/mcp`; add/remove/connect/disconnect under `/api/experimental/mcp` |
| `provider.list`, `config.providers` | `GET /api/provider`, `GET /api/model`, `GET /api/model/default` |
| `command.list`, `app.agents`, `app.skills` | `GET /api/command`, `/api/agent`, `/api/skill` |
| `/event` SSE | `GET /api/event`: live only, no replay; durable replay is `/api/experimental/session/:id/log?follow` |
| `session.share` / `unshare` | none ("OpenCode V2 does not support session sharing yet") |
| `session.todo`, `todo.updated` | none: the todo tool was removed (`7feefb697f`) |
| `lsp.status`, `formatter.status` | none: 2.x does not run LSP |
| none | new: `inbox` (queued input), `background`, `switchAgent`/`switchModel`, `move`, `context`, `environment`, `shell`, `synthetic`, `worktree`, `vcs`, `credential`, `integration` |

The 2.x client package is `@opencode/client` (`OpenCode.make({ baseUrl,
headers, fetch })`), not `createOpencodeClient`. `@opencode/sdk` is now an
in-process embedded host (`OpenCode.create()`), not an HTTP client.

### Upstream readiness at 2.0.18, against the August 2026 gaps

| Gap recorded in August | 2.0.18 |
| --- | --- |
| Specs marked experimental or pre-launch | `specs/v2/session.md` is the "Current semantic overview"; an endpoint audit puts `/api/experimental/*` outside the stable commitment. OpenAPI metadata still says "Experimental HttpApi surface" (stale) |
| V2 tables reset across releases | Last session-state wipe 2026-06-22; migrations since 2.0.0 are additive or a single column reset. No written compatibility policy found |
| `compact`, `wait` return `OperationUnavailable` | Implemented; `wait` is experimental |
| Command, shell, fork, revert, delete, abort, diff, permissions, questions | Present, reshaped as above. Share and todo absent |
| Runtime-context parity | `migrate-v1.mdx` declares three intentional breaks (plugins, server API, `tui.json` → `cli.json`) and lists gaps: no LSP, no `CLAUDE.md` fallback, `compaction.tail_turns`/`prune` ignored |
| No post-crash recovery | Write-ahead execution claim; restart resumes claimed sessions (at most 10 attempts). Running tool calls are marked failed. Exactly-once is explicitly not guaranteed |
| No atomic stale-turn guard for steer | Still no expected-turn precondition. Steer/queue are durable inbox semantics with idempotent IDs and `409 LifecycleConflict` |
| Mixed V1/V2 execution on one session | Moot: 2.x has one runner and no V1 routes |
| Unbounded queues, deltas, tools | SSE: 4,096-frame dropping queue per connection (`SubscriberOverflowError`), 15 s heartbeat. Tool output head+tail bounded. Provider retries at most 4. No inbox length cap found |
| OpenCode's own app uses legacy fallbacks | None: `packages/app` and `packages/tui` depend only on `@opencode/client` |

## Outstanding work

### Code

Nothing until the readiness gate below opens. Then treat 2.x as a new provider
rather than an upgrade:

1. Add an `opencode2` provider beside the current one. It gets a separate binary
   pin from the npm platform tarballs with new digests, a separate
   `OPENCODE_DB`, `@opencode/client`, and a persisted `legacy` / `v2` protocol
   marker on the session mapping.
2. Build the 2.x projection on `message.list` / the session log as the snapshot,
   with `/api/event` as hints, per the inactive-environment rules. The live
   stream has no replay, so reconnect must re-read the snapshot.
3. Decide each loss below explicitly: rebuild, capability-gate or drop.
4. Adopt native steer and queue through `delivery` and the inbox. Still do not
   advertise turn-pinned `/steer` until an expected-turn precondition exists.
5. Retire the 1.x provider only after legacy sessions have a keep, migrate or
   retire policy.

The rewrite surface is backend-only. Since #970 the renderer has no OpenCode
client or normalizer (`apps/web/src/lib/opencode-messages.ts` is gone). In
`apps/backend/src/core/`:

- events and transcript: `opencode-stream-state.ts`, `opencode-events.ts`,
  `opencode-observation-stream.ts`, `opencode-messages.ts`,
  `opencode-snapshots.ts` (the `before` cursor, `openCodeHistoryCursor`),
  `opencode-display-transcript.ts`, `opencode-stream-reconciliation.ts`;
- interactions: `opencode-interactions.ts` (questions become forms, `reply`
  becomes `decision`);
- prompts: the `session.promptAsync` call in `OpenCodeProvider`
  (`opencode-provider.ts`), with its per-prompt `model`, `agent`, `variant` and
  read-only `tools` mask (`OPENCODE_READ_ONLY_TURN_TOOLS`);
- sessions: `opencode-review-session-permissions.ts`,
  `opencode-structured-output.ts`, `opencode-capabilities.ts`;
- launch and health: `configureOpenCodeAgentTools` (`opencode-agent-tools.ts`), the
  `checkHttpHealth` calls in `commands-containers.ts`, and the GitHub-token
  plugin `buildOpenCodeGitHubEnvironmentPluginSource`
  (`agent-credential-files.ts`);
- MCP management, which reads and writes V1 config keys
  (`mcp-management/`).

Concrete changes that must ship with the first 2.x pin:

- a health probe on `GET /api/info` that rejects HTML;
- the persisted `legacy` / `v2` marker, and an isolated `OPENCODE_DB` on the
  host and in containers;
- the `shell.env` GitHub-token plugin ported to `@opencode/plugin`
  (`Plugin.define({ id, setup(ctx) })`), because V1 plugins do not run on 2.x;
- the live tests moved off `serve --pure`.

### Losses to decide

Measured against the current OpenCode usage, which is all legacy
`client.session.*`:

1. Per-prompt `model`, `agent` and `tools`. The 2.x prompt input is only `text`,
   `files`, `agents`, `skills`, `metadata`, `delivery` and `resume`. Model and
   agent become session state (`switchModel`, `switchAgent`). The read-only
   turn's per-prompt `tools` mask has no direct equivalent and must move to
   session permissions. Reviewer sessions already use session permissions
   (`opencode-review-session-permissions.ts`).
2. Structured output. 2.x prompts have no structured-output format, so the
   workflow result broker and `opencode-structured-output.ts` need a new
   mechanism.
3. Share and unshare. Already off: 1.x discontinued sharing in 1.19.1.
4. Todos. `session.todo` and `todo.updated` are gone, so the runtime summary
   loses OpenCode todos.
5. LSP and formatter status. Not available.
6. The GitHub-token plugin (ported as above).
7. The transcript model and events. `message.updated`, `message.part.updated`
   and `message.part.delta` are gone. 2.x emits `session.text.delta`,
   `session.step.*`, `session.tool.*`, `session.inbox.*`, `session.execution.*`
   and `form.*`.
8. MCP registration. The raw `POST /mcp` becomes
   `PUT /api/experimental/mcp/:server`, which is experimental.

### Session V2 features to adopt after the move

These need Session V2. In 1.x they are reachable only through the experimental
`client.v2.*` namespace, which this repository deliberately does not call:

- `delivery: steer | queue` and the inbox (OpenCode steer, see
  [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md));
- `switchAgent` / `switchModel`;
- `session.context`;
- durable event replay through the session log;
- staged revert (`revert/stage`, `revert/commit`);
- saved "always allow" permission rules (`v2.permission.saved` in the 1.x SDK);
- `credential` / `integration` for provider sign-in (see
  [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md));
- `reference.list` for `@` mentions.

### Readiness gate

Upstream conditions met at 2.0.18:

- Session events and projections are declared current, not disposable
  experimental state (the stable API excludes `/api/experimental/*`).
- OpenCode's own app no longer depends on legacy session fallbacks.
- `compact` is implemented (`wait` remains experimental).
- Command, shell, fork, revert, delete, interrupt, diff, permission and form
  semantics are implemented.
- Post-crash continuation has documented outcomes (bounded resume, not
  exactly-once).

Upstream conditions still open:

- A documented compatibility and migration policy for 2.x storage across 2.x
  releases.
- ~~Share implemented, or Orkestrator accepts dropping it.~~ Dropped with 1.19.1.
- 2.x equivalents for per-prompt model, agent and tools and for structured
  output, or accepted replacements.
- Runtime-context gaps (LSP, `CLAUDE.md` fallback, compaction tuning) closed or
  accepted.
- Active-run ownership that supports a stale-turn guard for steering.
- A bounded inbox, or one the client can bound.
- MCP add and remove endpoints out of `/api/experimental`.

### Qualification

Before any 2.x pin reaches production:

- SDK, CLI, container and desktop toolchain pinned to one exact 2.x release,
  sourced from the npm platform packages.
- Health probes use `/api/info` and reject HTML responses.
- A live 2.x probe covers create, prompt, exact retry, conflict, message list,
  log replay and tail hand-off, interrupt, permissions and forms, restart and
  teardown.
- Every current `client.session` use has a reviewed 2.x disposition.
- The session mapping persists `legacy` vs `v2`, and 2.x uses an isolated
  database until legacy sessions are retired.
- The GitHub-token plugin is ported to `@opencode/plugin`.
- Background test: run a turn, switch environments, let it progress, and check
  that it rehydrates correctly on return.
- Replay tests cover subscribe-before-snapshot, SSE overflow
  (`SubscriberOverflowError`) and bounded memory.
- Capability flags match 2.x (share, todos and LSP off).
- Native `/steer` tested for idle and end-of-turn races.

### Recheck procedure

1. Compare both lines' pins:

   ```sh
   npm view @opencode-ai/sdk dist-tags.latest   # 1.x
   npm view @opencode/cli dist-tags.latest      # 2.x
   ```

2. Read, pinned to the release tag: `specs/v2/session.md`,
   `services/www/src/docs/content/migrate-v1.mdx`, `V2_HTTP_API_AUDIT.md`,
   `packages/schema/src/prompt-input.ts`, and the database migrations since the
   last checkpoint.
3. Install the 2.x CLI into a temporary directory and run it with an isolated
   `HOME` / `XDG_*`, never against the real data directory. Diff `/openapi.json`
   against the routes the provider calls.
4. Run `mise run verify:opencode:live` for the 1.x pin.
5. Update this file's check line, pins, tables and the readiness gate.

## Constraints and rationale

- Stay on the 1.x line (pin `1.19.4`) for production while 1.x keeps shipping.
  Keep `OPENCODE_DISABLE_AUTOUPDATE=1` on every OpenCode process so a pinned
  binary is never offered the in-place upgrade.
- Never open a 1.x session through 2.x implicitly.
- Coexistence and data:
  - 2.x uses the same `opencode.db` path as 1.x
    (`~/.local/share/opencode/opencode.db`). On start it runs a background V1
    migration (Bun binary only): legacy `session` → `session_v2`,
    `message`/`part` → `session_message`, the `event` table deleted, with
    progress at `GET /api/experimental/migration/v1`. The 2.x schema has no
    `message`/`part` tables. The host database on the development machine was
    about 6.4 GB.
  - Starting 2.x against the user's real data directory therefore mutates the
    database the user's own 1.x TUI also uses. Running 1.x afterwards against a
    migrated database is untested upstream.
  - If both versions must run during a rollout, give 2.x its own `OPENCODE_DB`
    (or XDG data directory) and persist the protocol per Orkestrator session.
- Operational differences in 2.x:
  - Distribution: `packages/toolchain/src/manifest.ts` and `docker/Dockerfile`
    download GitHub Release archives; 2.x artifacts must come from
    `@opencode/cli-<platform>` npm tarballs.
  - Auth: a password is always required (generated and printed if unset).
    `OPENCODE_SERVER_PASSWORD` still works; `OPENCODE_SERVER_USERNAME` is
    ignored and the username is fixed to `opencode`, which is what the backend
    sends. Basic auth, `?auth_token=` or a pairing cookie.
  - Directory scoping: the `x-opencode-directory` header or
    `?location[directory]=`. Sessions carry `location.directory`.
  - Config: V1 `opencode.json` is still accepted and normalized in memory, but
    native V2 keys differ (`agents`; `permissions` as ordered rules with
    `bash` → `shell` and `task` → `subagent`; `mcp.servers.<name>`; `providers`;
    `plugins`). `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`,
    `OPENCODE_CONFIG_DIR` and `OPENCODE_DB` are still honoured;
    `OPENCODE_PERMISSION` is not. Upstream issue #50286 reports the V1
    normalization overwriting a custom provider `baseURL`.
  - Credentials: `auth.json` is imported once into the database and not read
    afterwards; credentials then live in `/api/credential` and
    `/api/integration`. The container entrypoint copies `auth.json` into a fresh
    data directory, which imports on first start, but later host credential
    changes would not propagate.
  - In-app provider sign-in (`opencode-provider-login.ts`) calls 1.x's
    `PUT|DELETE /auth/{providerID}`, `GET /provider/auth` and
    `/provider/{id}/oauth/{authorize,callback}`, which write `auth.json`. It
    has to move to `/api/credential` and `/api/integration` with 2.x. A user
    who already runs 2.x as their own CLI signs in there, and 1.x never sees
    it: that is how an expired `opencode-go` key in `auth.json` kept failing
    in the app while the 2.x CLI worked.
  - CLI: `serve` flags are `--hostname`, `--port`, `--cors`, `--service` and
    `--stdio`. `serve --pure` is gone. The npm bin also installs an `opencode2`
    alias.

## Open questions

- What is the policy for existing 1.x sessions when 2.x arrives: keep them on a
  1.x binary, migrate them, or retire them?
- Which losses are acceptable to drop outright (share, todos, LSP status)?

## Needs verification

- Upstream state since 2026-09-27 (2.0.18): a newer 2.x release, a storage
  compatibility policy, a steer precondition, MCP endpoints leaving
  experimental. Run the recheck procedure above before picking this up.

## Related

- [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md) and
  [0028-coordinator-consistency-gaps.md](../coordinator-and-multi-review/0028-coordinator-consistency-gaps.md) (OpenCode
  steer is blocked on this).
- [0039-mcp-management.md](../mcp/0039-mcp-management.md) (`POST /mcp` →
  `PUT /api/experimental/mcp/:server`, V1 config keys).
- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md)
  (saved rules).
- [0006-session-titles-and-history.md](0006-session-titles-and-history.md) (staged
  revert).
- [agent-engines.md](../../architecture/agent-engines.md) "OpenCode" and
  "Maintaining the OpenCode integration";
  [upgrade-agents.md](../../development/upgrade-agents.md) (the OpenCode bump
  runbook).
- Upstream references (branch `v2`, tag `v2.0.18`):
  - [Session specification](https://github.com/anomalyco/opencode/blob/v2.0.18/specs/v2/session.md)
  - [Event stream architecture](https://github.com/anomalyco/opencode/blob/v2.0.18/specs/v2/event-stream-architecture.md)
  - [V1 migration guide](https://github.com/anomalyco/opencode/blob/v2.0.18/services/www/src/docs/content/migrate-v1.mdx)
  - [Prompt input schema](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/schema/src/prompt-input.ts)
  - [Session HTTP handlers](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/server/src/handlers/session.ts)
  - [V1 data migration](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/core/src/database/v1-migration.bun.ts)

## Replaces

- The previous `docs/todo/opencode-v2.md` (rewritten in place: durable content
  carried over, file references corrected)
- `docs/plans/sdk-coverage/13-opencode-v1-streaming-and-cleanup.md` (done; its
  out-of-scope list is this file; the inactive-path browser run is in
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md))
- `docs/plans/sdk-coverage/00-index.md` ("Deliberately not planned: OpenCode v2
  session protocol")
- `docs/plans/sdk-coverage/05-mid-turn-control-steer-and-interrupt.md`
  ("OpenCode steering" out of scope)
- `docs/plans/sdk-coverage-2026-09-06.md` (OpenCode §5 introduction, §5.6,
  §5.9; Tier 3 row 27)
