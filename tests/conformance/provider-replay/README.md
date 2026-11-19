# Provider-traffic replay

Recorded provider traffic, replayed through each bridge's production
ingestion path, so a provider upgrade or an adapter change cannot silently
change what a recorded scenario shows: its transcript rows, its pending
interactions, and how its turn ends.

Codex has its own harness for app-server streams
(`bridges/codex-bridge/src/app-server/notification-replay.test.ts`, fixtures in
`bridges/codex-bridge/src/testing/fixtures/`). This suite covers the other four
managed bridges.

## Layout

| File | Role |
| --- | --- |
| `fixture.ts` | The JSONL fixture format and its parser |
| `observation.ts` | What a replay pins, and how a bridge's state is reduced to it |
| `scenarios.ts` | The scenario catalogue and `runProviderReplaySuite` |
| `capabilities.ts` | Which scenario applies to which bridge, with the reason when one does not |
| `bridges/<name>/src/conformance-provider-replay.test.ts` | The bridge's adapter: feeds frames to its real ingestion path |
| `bridges/<name>/src/testing/provider-replay/*.jsonl` | Its fixtures |
| `bridges/<name>/src/testing/provider-replay/*.expected.json` | What each fixture must replay to |

`tests/unit/provider-replay-conformance.test.ts` checks the wiring from
outside: complete capability rows, runners in the default test tier, every
fixture parsing as its bridge, and nothing in a fixture or expectation that
the recording scrubber would redact.

## What each adapter drives

| Bridge | Frames are | Delivered through |
| --- | --- | --- |
| Claude | Agent SDK messages (`query()` output; the CLI's stream-json) | The session manager's real turn, via the `query()` double; a `control_request`/`can_use_tool` frame is delivered as the SDK's `canUseTool` call |
| Cursor | `@cursor/sdk` interaction updates | The real router and prompt route; each update goes to the `onDelta` callback the bridge gave `agent.send` |
| Pi | Pi `AgentSessionEvent`s | The real router and attach path; each event goes to the listener the bridge subscribed with; a `tool_call` frame goes to the approval hook |
| ACP (Grok) | JSON-RPC lines from the agent | A real bridge process and `AcpProcess`; a relay agent (`testing/fake-agent-replay-relay.ts`) writes each line to its stdout |

## Fixture format

The first line is a header; every later line is one step.

```jsonl
{"replay":1,"bridge":"pi","scenario":"approval-denial","source":"synthetic","provider":"@earendil-works/pi-coding-agent","providerVersion":"1.5.2","description":"…"}
{"action":"prompt","text":"Delete the build directory","policy":"ask"}
{"frame":{"type":"message_start","message":{"role":"assistant"}}}
{"action":"observe","label":"parked"}
{"action":"answer","decision":"deny"}
```

- `source` is `recorded` (captured with the recorder below and scrubbed) or
  `synthetic` (hand-written in the recorded shape, no real data).
- `{"frame": …}` is provider traffic in the bridge's native shape. Each
  adapter's header comment lists its placeholders (`"$derived"` for Claude,
  `"$prompt"` and `"$load"` for ACP).
- `{"action": …}` is what the user, the backend or the provider did between
  frames. Shared actions are `prompt`, `answer` (`decision` allow | deny),
  `interrupt` and `observe` (`label`); each adapter documents the rest
  (`end`, `settle`, `restart`, `resume`, `await-prompt`). An adapter throws on
  an action it does not implement, so a step is never skipped silently.

Every replay records a checkpoint at each `observe` and one labelled `end`.
A checkpoint holds the rows (role, part types, tool names and states, short
prose excerpts, output lengths), the live tail as the v2 transcript summary
reports it (including rows outside it that it carries as revised), pending
interactions, activity, completion, the runtime-health drift (provider
vocabulary the bridge had no branch for), and adapter facts such as the
decision returned to the provider for a parked approval.

## Scenarios

`basic-turn`, `approval-denial`, `interruption`, `late-background-output`,
`resume`, `session-rekey`, `malformed-events`, `outside-tail-update`. Each
also asserts the property it exists for (for example, a checkpoint with an
interaction pending, or a row outside the live tail reaching readers as
revised), so a regenerated expectation cannot quietly drop it. Scenarios a
provider cannot produce are `supported: false` in `capabilities.ts`, with the
reason.

## Running and updating

```bash
# One bridge's corpus (each bridge's test:bridge group runs it under mise run test):
cd bridges/pi-bridge && bun test src/conformance-provider-replay.test.ts \
  --preload ../../tests/setup-node.ts --preload ./src/testing/test-isolation.ts

# Regenerate expectations after an intended change, then format and read the diff:
ORKESTRATOR_PROVIDER_REPLAY_UPDATE=1 bun test src/conformance-provider-replay.test.ts --preload …
mise run format
git diff -- src/testing/provider-replay/
```

A changed expectation after a provider bump or an adapter change is the
signal this suite exists to raise. Understand it before accepting it: a
renamed field that now renders nothing, a tool card that no longer settles,
or a new drift kind is an adapter decision, not a snapshot refresh.

## Recording real traffic

Every one of the four bridges carries an opt-in recorder
(`@orkestrator/protocol/node/provider-replay-recorder`). It needs both
variables, because a recording holds every prompt, file content and absolute
path verbatim:

```bash
ORKESTRATOR_PROVIDER_RECORD_DIR=/tmp/provider-recordings \
  ORKESTRATOR_PROVIDER_RECORD_CONFIRM=1 \
  mise run dev:test --profile replay-recording --fixture
```

Drive the scenario in a **local** fixture environment: a local bridge inherits
the backend's environment, while a container's bridge does not receive these
variables. It writes one file per session (per agent process for ACP) in this format,
with the header's `scenario` set to `unclassified` and its `providerVersion`
read from the installed SDK or the agent's own `initialize`. Prompt text is
never recorded; a turn's start is an `{"action":"prompt"}` line. To turn one
into a fixture:

1. Copy it into the bridge's `src/testing/provider-replay/`, named after the
   scenario, and set `scenario` and `description` in the header.
2. Add the actions the user took (`answer`, `interrupt`), the checkpoints to
   pin (`observe`), and the adapter's settling actions (`end`, `settle`).
   Replace ids the replay cannot know in advance with the adapter's
   placeholders.
3. Scrub it: `bun scripts/scrub-codex-recording.ts <in> <out>` (the scrubber
   is format-agnostic; add `--strip-content` to blank prose), then **read the
   diff**. The guard test rejects anything the scrubber would still redact,
   but it cannot recognise a secret it has no pattern for.
4. Generate its expectation with `ORKESTRATOR_PROVIDER_REPLAY_UPDATE=1`, read
   it, and commit both files.

## What a recording cannot prove

A recording pins what a provider emitted when it was captured. It cannot show
that a newly released CLI or SDK still emits the same thing. Keep the small
live checks each bridge has (its `*.live.test.ts` files and the qualification
steps in [`docs/development/upgrade-agents.md`](../../../docs/development/upgrade-agents.md)),
and record a fresh fixture for a scenario whenever a bump changes its traffic.
