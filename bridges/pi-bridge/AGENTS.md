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
- A session with no explicit model starts on Pi's saved default
  (`defaultProvider`/`defaultModel`, what `/model` writes) when a signed-in
  provider serves it, then on `PI_BRIDGE_DEFAULT_MODEL`, then on the
  catalogue's first model (`defaultModelIds` in `agent-session.ts`). Never fall
  straight to the first model: a login can refuse models its provider lists,
  and a ChatGPT login refuses the first one (under `openai` since Pi 1.2.0,
  and under the legacy `openai-codex`). Project
  settings count only when the session trusts the project.
- Tests run with `src/testing/test-isolation.ts` preloaded (`test:bridge`). It points
  `PI_CODING_AGENT_DIR` at a temporary directory, so no test reads the
  developer's saved default or writes `auth.json`/`models-store.json` into
  their `~/.pi/agent`. A focused `bun test` outside `test:bridge` should add
  `--preload ./src/testing/test-isolation.ts` or isolate its own directory.
- `credentials.ts` reports per-provider status and deliberately implements no
  sign-in. Pi's login is an interactive multi-step prompt flow with no
  counterpart in Orkestrator's session surface, and the credential it writes is
  account-wide rather than per-environment. Users sign in with `/login` in a Pi
  terminal tab or by writing `auth.json`; containers are handed the resulting
  directory as a bind mount.

## One row per model response

`translate.ts` writes each model response to a row of its own: Pi's
`message_start` for an assistant message closes the current row, and the next
content opens one lazily. Pi runs a response's tools after its `message_end`
and before the next `message_start`, so their cards stay on the row of the
response that requested them. Never fold a whole turn back into one row: a
turn can run for hours, and a multi-megabyte row fits no transcript window, so
readers can only show a front-trimmed copy and lose it once newer rows push it
out of the live tail. A tool update, result or image goes to the row holding
that call (`toolCallRows`), a nested call to the row holding its parent, and a
`tool_execution_start` always to the current row, because some providers
reuse call ids across responses. Every row change goes through `rowChanged` /
`noteRowRevised` (`src/transcript.ts`): it bumps `state.revision`, which is what
the backend's transcript token keys on, and notes the row for
`revisedMessageIds`, so a late update to a row newer ones pushed out of the
live window reaches readers through `revisedMessages`. `resetRenderedHistory`
clears the notes; a new change site must use the helper, not bump `revision`
alone. "Did this turn answer" is
`turnOpenedAssistantRow`, not `currentAssistantMessageId`, which a response
boundary clears mid-turn. A resume replays one row per Pi entry, dated by the
entry, so live and resumed transcripts have the same shape.

## When touching the Pi bridge

- The engine boundary is `src/translate.ts` and `src/tool-rendering.ts`. Every
  Pi-specific shape stops there; nothing downstream should learn a new field to
  render a Pi turn.
- Pi does not fail a run by rejecting it. A provider error, or a run that
  threw (an OAuth refresh that failed), arrives as an assistant message with
  `stopReason: "error"` and the run still resolves; `translate.ts` keeps the
  last response's failure (`turnError`) and `finishTurn` fails the turn with
  it. Pi retries within the same run, so only the last response counts.
- Pi refuses a prompt in preflight with a plain error. Nothing has run, so the
  route answers a definite refusal, never the outcome-unknown 500: 401
  `authentication-required` when the bridge's own check finds the model's
  provider signed out (`assertModelSignedIn`, after Pi refuses preflight), otherwise
  422 `prompt-refused` with Pi's reason (`PromptRefusedError`). Local extension
  commands and input handlers run before Pi needs model credentials; never put
  a selected-model auth check ahead of their dispatch. Selected command bindings
  are still validated before any command can execute.
- `applySessionEvent` never awaits. It runs on the SDK's own listener, so an
  await there would let a large transcript back-pressure a live run.
- A tool variant Pi adds — or a custom tool from a project extension, whose
  shape this bridge cannot know at all — must degrade to a plain card, never
  throw. These branches run mid-turn.
- The conversation lives in Pi's own JSONL session file, not in this bridge.
  Losing the bridge's state costs a rendered transcript; it never costs the
  conversation. That is why `detachSession` keeps `sessionFile` and why a
  restart re-attaches to the same session rather than starting a new one.
- Approvals follow the session's execution policy: `ask` parks a call, `deny`
  refuses it, and a session with no policy runs as the host default,
  `auto-approve`. When the gate asks, every timeout,
  disconnect, closing session and unparseable answer **denies**. A turn that
  ends with a call still parked denies it too — leaving it unanswered wedges the
  turn and, with it, the environment's activity state.
- A pause (`POST …/approvals/:approvalId/hold`) only moves the approval's
  deadline — to the 24 h ceiling, capped by the turn budget
  (`turnDeadlineAt`) — and expiry there still denies. It never answers the
  call; keep it routed ahead of the decision route, which denies by default.
- A prompt claims a process-local token (`promptClaim`) synchronously at route
  entry, before its body is read, when nothing else owns the session; an
  unused reservation (validation error, duplicate, local answer, busy refusal)
  is released with its own cancel record only. A cancel that arrives before Pi
  has produced a cancel handle is parked against that claim and answered 202
  `{ cancelled: false, pending: true }`, never `cancelled`; so is a provider
  abort that hangs or rejects (the next request retries it). The prompt route
  checks for it after every preparation await and settles without calling Pi.
  In Pi's preflight the cancel calls `session.abort()` at once (pinned SDK
  1.4 aborts an auto-compaction and pre-empts a run `_startRun` is preparing;
  that abort waits for the run to settle, so it is never awaited) and again
  when Pi accepts, because `_startRun` resets the abort flag when it begins.
  A run Pi reports settled with `aborted: true` — whoever aborted it,
  including an extension — ends the turn cancelled (idle, structured result
  `interrupted`), never completed. Acceptance is bounded by
  `PI_BRIDGE_STARTUP_TIMEOUT_MS` (default 5 min, floor 30 s): past it the route
  answers 424 with an explicit error, but the claim and `dispatching` are kept
  until Pi settles the prompt — a late acceptance is aborted and observed — so
  every status route reports running while something can still reach Pi.
  Config and compaction take no claim, so a cancel during them cannot stop a
  later prompt. Close and DELETE mark the session closed before their first
  await: new prompts get 409, one still preparing settles as cancelled, and
  `/close` keeps the session registered until its removal is published (503
  pending otherwise).
- Project-local `.pi/` resources load only when the session's execution
  policy turns `projectResources` on, on both host and container runs. Host
  project resources are off by default. Enabling them permits repository MCP processes and Pi extensions
  (arbitrary TypeScript) to run on the host.
- Pi's SDK sessions load no MCP client (only its CLI loads the built-in `mcp`
  extension) and have no plan/build mode. The bridge owns an MCP client (`src/mcp.ts`) and registers tools through the inline
  `orkestrator-mcp` extension: Orkestrator from env / per-tab `agentMcp`,
  user servers from `~/.pi/agent/mcp.json`, and project `.pi/mcp.json` only
  when the execution policy opts into project resources. A session records
  a fingerprint of the MCP files it was built from and rebuilds at the next
  turn start when they change (never mid-turn), which is how saved edits from
  the MCP servers settings reach a live session. `mcp-config.ts` reads that
  file as Pi's own format (one leading UTF-8 BOM stripped, `enabled: false`,
  `$NAME`/`${NAME}` values, `~/`, `cwd`) and never runs a `!command` value — an entry needing one is skipped,
  and the bridge's own secret variables cannot be named by a `${…}` reference.
  It merges the files with Pi 1.x's rules (project overrides, `-`/`_` name
  clashes, `auth` refused in a project file); an entry Pi's validator rejects
  hides nothing. `src/mcp-config-upstream.test.ts` runs it against the pinned
  Pi's own loader, and the backend's MCP catalogue mirrors it under
  `pi-mcp-parity.test.ts`, both over `src/testing/mcp-config-fixtures.ts` (a `RawMcpConfigText` fixture
  is written verbatim, for bytes `JSON.stringify` cannot produce).
  Settings-pane
  discovery still reports an empty MCP list (pre-session fallback). The
  composer reports `mode: false` because plan/build is still something an
  extension adds. `agentMailCapabilities("agent-native", "pi")` is on;
  terminal `pi` stays off.
- The SDK and the pinned `pi` binary are the same program, so they are pinned to
  the same version and `tests/unit/version-drift.test.ts` enforces it — a bump
  that moves one and not the other gives a user two different agents behind one
  platform name.
