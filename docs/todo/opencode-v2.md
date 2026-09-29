# OpenCode 2.x upgrade checkpoint

Status: Deferred — do not bump the OpenCode binary or SDK to 2.x.  
Recorded: 2026-08-28; refreshed 2026-09-27 against OpenCode `v2.0.18`.  
Orkestrator OpenCode SDK and CLI pin: `1.18.33` (`@opencode-ai/sdk`, `opencode-ai`)

## Summary

The situation changed shape since the August checkpoint. The V2 Session
protocol is no longer an experimental side API inside 1.x: it shipped as a
separate major product, **OpenCode 2.0** (2.0.0 on 2026-09-11, 2.0.18 on
2026-09-25), which deletes the legacy HTTP API entirely.

- The 1.x line lives on upstream `dev` and still ships as `opencode-ai` /
  `@opencode-ai/sdk` (latest at this checkpoint: `1.18.33`). Our pin is current for
  1.x, which is why the version check looked clean.
- The 2.x line lives on upstream branch `v2` and ships under a **new npm
  scope**: `@opencode/cli`, `@opencode/client`, `@opencode/sdk`,
  `@opencode/server`, `@opencode/protocol`. 2.x has git tags but no GitHub
  Releases; binaries ship only as `@opencode/cli-<platform>` npm packages.
- A 2.x server serves only `/api/*`. **The 1.18.32 SDK's `client.session.*`
  surface cannot drive it**, and there is no compatibility flag.
- Most V2 Session gaps recorded in August are now closed upstream, but the
  migration is a rewrite of the OpenCode bridge, not a version bump.

## Can we upgrade the binary but keep the v1 SDK?

No. Verified live on 2026-09-27 with `@opencode/cli@2.0.18` in an isolated
HOME/XDG and `@opencode-ai/sdk@1.18.32`:

| Call (1.18.32 SDK / our raw HTTP) | 2.0.18 result |
| --- | --- |
| `client.session.list`, `client.global.health`, `client.config.get` | throws `Request is not supported by this version of OpenCode Server (Server responded with text/html)` |
| `client.session.create` | `405` |
| raw `GET /global/health`, `/session`, `/config`, `/provider`, `/mcp` | **`200 text/html`** — the bundled web app's SPA fallback, served before auth |
| raw `POST /mcp` (our `configureOpenCodeAgentTools`) | `405` |
| `client.v2.session.list` | `200` JSON — but 11 of the old SDK's 51 `/api` routes no longer exist on 2.x (questions→forms, per-session `history`/`event`, `wait`, `revert/clear`, `/api/health`) |

Upstream confirms the legacy routes were removed, not deprecated: the server
route table registers only `/api/...` (plus `/auth/connect/:code` and
`/openapi.json`), and `packages/opencode` (the 1.x runtime) no longer exists
on `v2`. `packages/server/src/options.ts` has no legacy toggle.

**Hazard:** `checkHttpHealth` (`apps/backend/src/core/commands-server-health.ts`)
treats any 2xx on `/global/health` as healthy. A binary-only bump would
therefore report the server healthy and then fail every session call. Any
pin change must also change the health probe to `GET /api/info`.

The only way to use both at once is to run **two binaries**: 1.x for
legacy sessions and 2.x for new ones, each with its own data directory or
`OPENCODE_DB` (see [Coexistence](#coexistence-and-data)).

## What 2.x is now

### API surface (`/openapi.json`, 2.0.18)

| 1.x (what we call) | 2.x |
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
| `/event` SSE | `GET /api/event` — live only, no replay; durable replay is `/api/experimental/session/:id/log?follow` |
| `session.share` / `unshare` | **none** — "OpenCode V2 does not support session sharing yet" |
| `session.todo`, `todo.updated` | **none** — todo tool removed (`7feefb697f`) |
| `lsp.status`, `formatter.status` | **none** — LSP is not run in 2.x |
| — | new: `inbox` (queued input), `background`, `switchAgent`/`switchModel`, `move`, `context`, `environment`, `shell`, `synthetic`, `worktree`, `vcs`, `credential`, `integration` |

The client package is `@opencode/client` (`OpenCode.make({ baseUrl, headers,
fetch })`), not `createOpencodeClient`. `@opencode/sdk` is now an in-process
embedded host (`OpenCode.create()`), not an HTTP client.

### Session readiness vs. the August gaps

| August gap | 2.0.18 |
| --- | --- |
| Specs marked experimental/pre-launch | `specs/v2/session.md` is "Current semantic overview"; an endpoint audit marks `/api/experimental/*` as outside the stable commitment. OpenAPI metadata still says "Experimental HttpApi surface" (stale) |
| V2 tables reset across releases | Last session-state wipe was 2026-06-22; migrations since 2.0.0 are additive or a single column reset. **No written compatibility policy found** |
| `compact`, `wait` return `OperationUnavailable` | Implemented; `wait` is experimental |
| command/shell/fork/revert/delete/abort/diff/permissions/questions parity | Present (reshaped as above). Share and todo absent |
| Runtime-context parity checklist incomplete | `migrate-v1.mdx` declares three intentional breaks (plugins, server API, `tui.json`→`cli.json`) and lists gaps: no LSP, no `CLAUDE.md` fallback, `compaction.tail_turns`/`prune` ignored |
| No post-crash recovery | Write-ahead execution claim; restart resumes claimed sessions (≤10 attempts). Running tool calls are marked failed. Exactly-once is explicitly not guaranteed |
| No atomic stale-turn guard for steer | Still **no expected-turn precondition**. Steer/queue is durable inbox semantics with idempotent IDs and `409 LifecycleConflict` |
| Mixed V1/V2 execution on one session | Moot: 2.x has one runner and no V1 routes |
| Unbounded queues/deltas/tools | SSE: 4,096-frame dropping queue per connection (`SubscriberOverflowError`), 15 s heartbeat. Tool output head+tail bounded. Provider retries ≤4. **No inbox length cap found** |
| OpenCode's own app uses legacy fallbacks | None: `packages/app` and `packages/tui` depend only on `@opencode/client` |

## Features Orkestrator would lose or have to rebuild

Measured against the current inventory of our OpenCode usage (no
`client.v2.*` calls today; everything is legacy `client.session.*`):

1. **Per-prompt `model`, `agent`, and `tools` overrides.** We send these on
   every `promptAsync` (`opencode-provider.ts:793-820`). The 2.x prompt input
   is only `text`, `files`, `agents`, `skills`, `metadata`, `delivery`,
   `resume`. Model and agent become session state (`switchModel`,
   `switchAgent`); the per-prompt tools mask used by reviewer sessions
   (`opencode-review-permissions*.ts`) has no direct equivalent and must move
   to session permissions.
2. **Structured output.** No structured-output format on prompts. The
   workflow result broker and `opencode-structured-output.ts` need a new
   mechanism.
3. **Share / unshare.** No endpoint. Must be capability-gated off.
4. **Todos.** `session.todo` and `todo.updated` are gone; the runtime summary
   loses OpenCode todos.
5. **LSP and formatter status.** Not available.
6. **The GitHub-token plugin.** V1 plugins do not run on 2.x. The container
   `shell.env` plugin (`commands-runtime-state.ts:235-268`) must be ported to
   `@opencode/plugin` (`Plugin.define({ id, setup(ctx) })`).
7. **Transcript model and events.** `message.updated` / `message.part.updated`
   / `message.part.delta` are gone. 2.x emits `session.text.delta`,
   `session.step.*`, `session.tool.*`, `session.inbox.*`,
   `session.execution.*`, `form.*`. `opencode-stream-state.ts`,
   `opencode-events.ts`, `opencode-messages.ts` (backend and web), and the
   `Part`-based renderer normalization all need rewriting. The live stream has
   no replay, so reconnect must use the session log or message list as the
   authoritative snapshot.
8. **MCP registration.** Our raw `POST /mcp` becomes
   `PUT /api/experimental/mcp/:server` (experimental).

## Operational changes

- **Distribution.** `manifest.ts` and `docker/Dockerfile` download
  GitHub Release archives. 2.x has no GitHub Releases; artifacts must come
  from `@opencode/cli-<platform>` npm tarballs, with new digests.
- **Auth.** A password is always required (generated and printed if unset).
  `OPENCODE_SERVER_PASSWORD` still works; `OPENCODE_SERVER_USERNAME` is
  ignored (username fixed to `opencode`, which is what we send). Basic auth,
  `?auth_token=`, or a pairing cookie.
- **Directory scoping.** `x-opencode-directory` header or
  `?location[directory]=`; sessions carry `location.directory`.
- **Config.** V1 `opencode.json` is still accepted and normalized in memory,
  but native V2 keys differ (`agents`, `permissions` ordered rules with
  `bash`→`shell` and `task`→`subagent`, `mcp.servers.<name>`, `providers`,
  `plugins`). Our MCP management reads and writes V1 keys. `OPENCODE_CONFIG`,
  `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, and `OPENCODE_DB` are still
  honoured; `OPENCODE_PERMISSION` is not. Upstream issue #50286 reports the V1
  config normalization overwriting a custom provider `baseURL`.
- **Credentials.** `auth.json` is imported once into the database and not read
  afterwards; credentials then live in `/api/credential` and
  `/api/integration`. The container entrypoint copies `auth.json` into a fresh
  data dir, which would import on first start, but host credential changes
  made later would not propagate.
- **CLI.** `serve` flags are `--hostname`, `--port`, `--cors`, `--service`,
  `--stdio`. `serve --pure` (used by our live tests) is gone. The npm bin also
  installs an `opencode2` alias.

## Coexistence and data

2.x uses the **same** `opencode.db` path as 1.x
(`~/.local/share/opencode/opencode.db`) and on start runs a background V1
migration (Bun binary only): legacy `session` → `session_v2`, `message`/`part`
→ `session_message`, the `event` table deleted, and progress exposed at
`GET /api/experimental/migration/v1`. The 2.x schema has no `message`/`part`
tables. The host DB on the development machine is ~6.4 GB.

Consequences:

- Starting 2.x against the user's real data directory mutates the database the
  user's own 1.x OpenCode TUI also uses. Running 1.x afterwards against a
  migrated database is untested upstream.
- If both versions must run during a rollout, give 2.x its own `OPENCODE_DB`
  (or XDG data dir) and persist the protocol per Orkestrator session. Never
  open a 1.x session through 2.x implicitly.

## Recommendation

Stay on `1.18.33` for production. 1.x is still receiving releases and fixes
on `dev`; no end-of-life notice for 1.x was found.

When picking this up, treat it as a new provider rather than an upgrade:

1. Add an `opencode2` provider beside the current one: separate binary pin
   (npm platform tarballs), separate `OPENCODE_DB`, `@opencode/client`, and a
   persisted `legacy` vs `v2` protocol marker on the session mapping.
2. Build the 2.x projection on `message.list` / session log as the snapshot
   and `/api/event` as hints, per the repository's inactive-environment rules.
3. Decide each loss above explicitly (rebuild, capability-gate, or drop):
   per-prompt tools mask, structured output, share, todos, LSP status, and the
   GitHub-token plugin.
4. Adopt native steer/queue via `delivery` and the inbox, but still do not
   advertise turn-pinned `/steer` until an expected-turn precondition exists.
5. Retire the 1.x provider only after legacy sessions have a keep, migrate, or
   retire policy.

## Readiness gate

### Upstream contract

- [x] Session events and projections are declared current rather than
  disposable experimental state (stable API excludes `/api/experimental/*`).
- [ ] Upstream documents a compatibility and migration policy for 2.x storage
  across 2.x releases.
- [x] OpenCode's own app no longer depends on legacy Session fallbacks.
- [x] `compact` is implemented (`wait` remains experimental).
- [x] Command, shell, fork, revert, delete, interrupt, diff, permission, and
  form semantics are implemented.
- [ ] Share is implemented, or Orkestrator has accepted dropping it.
- [ ] Per-prompt model/agent/tools and structured output have 2.x equivalents,
  or Orkestrator has accepted replacements.
- [ ] Runtime-context gaps (LSP, `CLAUDE.md` fallback, compaction tuning) are
  closed or accepted.
- [x] Post-crash continuation has documented outcomes (bounded resume;
  not exactly-once).
- [ ] Active-run ownership supports a stale-turn guard for steering.
- [ ] Inbox length is bounded or enforceable by the client.
- [ ] The MCP add/remove endpoints leave `/api/experimental`.

### Orkestrator qualification

- [ ] SDK, CLI, container, and desktop toolchain versions pinned to one exact
  2.x release, sourced from npm platform packages.
- [ ] Health probes use `/api/info` and reject HTML responses.
- [ ] A live 2.x probe covers create, prompt, exact retry, conflict, message
  list, log replay/tail handoff, interrupt, permissions/forms, restart, and
  teardown.
- [ ] Every current `client.session` use has a reviewed 2.x disposition.
- [ ] Session mapping persists `legacy` vs `v2`; 2.x uses an isolated DB until
  legacy sessions are retired.
- [ ] GitHub-token plugin ported to `@opencode/plugin`.
- [ ] Background tests: run a turn, switch environments, let it progress,
  verify correct rehydration on return.
- [ ] Replay tests cover subscribe-before-snapshot, SSE overflow
  (`SubscriberOverflowError`), and bounded memory.
- [ ] Capability flags match 2.x (share, todos, LSP off).
- [ ] Native `/steer` tested for idle and end-of-turn races.

## Recheck procedure

1. Compare both lines' pins:

   ```sh
   npm view @opencode-ai/sdk dist-tags.latest   # 1.x
   npm view @opencode/cli dist-tags.latest      # 2.x
   ```

2. Read, pinned to the release tag: `specs/v2/session.md`,
   `services/www/src/docs/content/migrate-v1.mdx`, `V2_HTTP_API_AUDIT.md`,
   `packages/schema/src/prompt-input.ts`, and the database migrations since
   the last checkpoint.
3. Install the 2.x CLI into a temporary directory and run it with isolated
   `HOME` / `XDG_*` (never against the real data dir), then diff
   `/openapi.json` against the routes the provider calls.
4. Run `mise run verify:opencode:live` for the 1.x pin.
5. Update this document's date, pins, tables, and checkboxes.

## Primary upstream references (branch `v2`, tag `v2.0.18`)

- [Session specification](https://github.com/anomalyco/opencode/blob/v2.0.18/specs/v2/session.md)
- [Event stream architecture](https://github.com/anomalyco/opencode/blob/v2.0.18/specs/v2/event-stream-architecture.md)
- [V1 migration guide](https://github.com/anomalyco/opencode/blob/v2.0.18/services/www/src/docs/content/migrate-v1.mdx)
- [Prompt input schema](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/schema/src/prompt-input.ts)
- [Session HTTP handlers](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/server/src/handlers/session.ts)
- [V1 data migration](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/core/src/database/v1-migration.bun.ts)
