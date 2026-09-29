# Pi bridge

`bridges/pi-bridge` drives Pi's own TypeScript SDK
(`@earendil-works/pi-coding-agent`) in process and serves the same HTTP routes
and the same transcript shape as every other bridge, so the backend, the store
and the renderer cannot tell which engine is behind a session. The rules in
[`bridges/AGENTS.md`](../AGENTS.md) and the root [`AGENTS.md`](../../AGENTS.md)
also apply.

Pi differs from the other platforms in one way that matters, and it is confined
to two files. Pi is a *harness*, not a vendor: it fronts fifteen-odd model
providers using the user's own credentials. So a model is identified by a pair
rather than a name, and "signed in" is one answer per provider.

- `models.ts` encodes the pair as `provider/modelId`, split on the **first**
  slash only — an OpenRouter id contains its own. This is the same encoding
  OpenCode already uses, so one convention covers both pickers.
- The reasoning axis is Pi's **thinking level**, and the supported set per model
  comes from Pi's own `getSupportedThinkingLevels` rather than being derived
  from `thinkingLevelMap` here. The rule is not the obvious one: a `null`
  mapping excludes a level, but `xhigh` and `max` additionally require an
  *explicit* mapping, so an absent key excludes those two and includes every
  other. Getting that wrong offers controls the model then clamps away, and a
  clamped turn succeeds — it simply thinks less than the user asked. `off` is a
  real level, not an absence; the shared `default` id has no Pi equivalent.
- A fresh session's level is resolved the way Pi resolves it — per-model
  setting, then global default, then `medium` — reading the same
  `settings.json` that `/thinking` writes, so one preference serves both the
  model picker and a Pi terminal tab. `thinking_level_changed` is echoed back
  into the composer so the picker shows the level actually in force after Pi
  clamps it.
- `credentials.ts` reports per-provider status and deliberately implements no
  sign-in. Pi's login is an interactive multi-step prompt flow with no
  counterpart in Orkestrator's session surface, and the credential it writes is
  account-wide rather than per-environment. Users sign in with `/login` in a Pi
  terminal tab or by writing `auth.json`; containers are handed the resulting
  directory as a bind mount.

## When touching the Pi bridge

- The engine boundary is `src/translate.ts` and `src/tool-rendering.ts`. Every
  Pi-specific shape stops there; nothing downstream should learn a new field to
  render a Pi turn.
- `applySessionEvent` never awaits. It runs on the SDK's own listener, so an
  await there would let a large transcript back-pressure a live run.
- A tool variant Pi adds — or a custom tool from a project extension, whose
  shape this bridge cannot know at all — must degrade to a plain card, never
  throw. These branches run mid-turn.
- The conversation lives in Pi's own JSONL session file, not in this bridge.
  Losing the bridge's state costs a rendered transcript; it never costs the
  conversation. That is why `detachSession` keeps `sessionFile` and why a
  restart re-attaches to the same session rather than starting a new one.
- Approvals are off unless `PI_BRIDGE_REQUIRE_APPROVAL=1`, matching the
  permissive default every other bridge here uses. When on, every timeout,
  disconnect, closing session and unparseable answer **denies**. A turn that
  ends with a call still parked denies it too — leaving it unanswered wedges the
  turn and, with it, the environment's activity state.
- A prompt claims a process-local token (`promptClaim`) synchronously at route
  entry, before its body is read, when nothing else owns the session; an
  unused reservation (validation error, duplicate, local answer, busy refusal)
  is released with its own cancel record only. A cancel that arrives before Pi
  has produced a cancel handle is parked against that claim and answered 202
  `{ cancelled: false, pending: true }`, never `cancelled`; so is a provider
  abort that hangs or rejects (the next request retries it). The prompt route
  checks for it after every preparation await and settles without calling Pi.
  In Pi's preflight the cancel calls `session.abort()` at once (pinned SDK
  0.87 aborts an auto-compaction there) and again when Pi accepts, because the
  run resets the abort flag when it starts. Acceptance is bounded by
  `PI_BRIDGE_STARTUP_TIMEOUT_MS` (default 5 min, floor 30 s): past it the route
  answers 424 with an explicit error, but the claim and `dispatching` are kept
  until Pi settles the prompt — a late acceptance is aborted and observed — so
  every status route reports running while something can still reach Pi.
  Config and compaction take no claim, so a cancel during them cannot stop a
  later prompt. Close and DELETE mark the session closed before their first
  await: new prompts get 409, one still preparing settles as cancelled, and
  `/close` keeps the session registered until its removal is published (503
  pending otherwise).
- Project-local `.pi/` resources are opt-in through
  `PI_BRIDGE_PROJECT_RESOURCES`, and only the container launcher opts in. A Pi
  extension is arbitrary TypeScript this process would execute, so cloning a
  repository must not be enough to run its code — the same boundary
  `ACP_APPROVE_PROJECT_MCPS` draws for the ACP bridge.
- Pi's vendor SDK has no MCP client and no plan/build mode. The bridge owns
  an MCP client (`src/mcp.ts`) and registers tools through the inline
  `orkestrator-mcp` extension: Orkestrator from env / per-tab `agentMcp`,
  user servers from `~/.pi/agent/mcp.json`, and project `.pi/mcp.json` only
  when the execution policy opts into project resources. A session records
  a fingerprint of the MCP files it was built from and rebuilds at the next
  turn start when they change (never mid-turn), which is how saved edits from
  the MCP servers settings reach a live session. `mcp-config.ts` reads that
  file as Pi's own format (`enabled: false`, `$NAME`/`${NAME}` values, `~/`,
  `cwd`) and never runs a `!command` value — an entry needing one is skipped,
  and the bridge's own secret variables cannot be named by a `${…}` reference.
  Settings-pane
  discovery still reports an empty MCP list (pre-session fallback). The
  composer reports `mode: false` because plan/build is still something an
  extension adds. `agentMailCapabilities("agent-native", "pi")` is on;
  terminal `pi` stays off.
- The SDK and the pinned `pi` binary are the same program, so they are pinned to
  the same version and `tests/unit/version-drift.test.ts` enforces it — a bump
  that moves one and not the other gives a user two different agents behind one
  platform name.
