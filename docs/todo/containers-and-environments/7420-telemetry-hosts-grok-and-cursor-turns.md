# Telemetry hosts: Grok and Cursor turns, and the release note

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`; re-analysed 2026-11-15
against `main` at `a8b89f154`, when task 2 was done with a loopback Cursor
backend. Left by to-do 6100, which
removed `sentry.io`, `statsig.anthropic.com` and `statsig.com` from the
default allowlist after Claude Code, Codex, OpenCode and Pi each finished
turns against a fake provider without them
([qualification record](../../development/container-qualification.md#agent-clis-without-telemetry-hosts-on-rootful-linux-engine-2026-11-06)).

### Tasks

1. **Run a Grok turn without the telemetry hosts**: a Grok Build turn in a restricted container with the three hosts refused, against a fake provider. Status: done. (Review follow-up, 2026-11-06.)
2. **Settle Cursor without a turn or with a real one**: decide whether the static evidence is enough for the Cursor SDK, or run one real turn. Status: done (2026-11-15, a Cursor SDK turn against a loopback fake Cursor backend in a restricted container).
4. **Record native arm64 qualification**: capture the telemetry-host suite result on the workflow's linux-arm64 runner. Status: blocked (waits on a Container live qualification run on linux-arm64).

### 1. Run a Grok turn without the telemetry hosts

**Problem.** `apps/backend/tests/container-live-telemetry-hosts.test.ts`
initially ran Claude Code, Codex, OpenCode and Pi, but not Grok. A local
provider route had not been qualified, and the suite does not use real logins.

**Context.** Grok 1.0.70's binary reads `GROK_XAI_API_BASE_URL`,
`GROK_CLI_CHAT_PROXY_BASE_URL`, `GROK_MODELS_BASE_URL` and
`GROK_MODELS_LIST_URL`, among others (a string search of the binary; none is
documented). It carries one Sentry DSN, for
`o4508179396558848.ingest.us.sentry.io`, and no Statsig host. Under the
gateway's name checks an entry allows exactly its own name, so the removed
`sentry.io` entry never let Grok reach that ingest host in a current
container: removing it changes nothing for Grok there. Only a container
without name checks (an older image, or `ORKESTRATOR_EGRESS_FILTER=off`)
matched by address.

**Investigation.** The review follow-up inspected Grok 1.0.70's help, which
exposes `--xai-api-base-url` and `--cli-chat-proxy-base-url` on `grok agent`.
An isolated, network-disabled preflight then completed `grok -p` using fake
keys and the four loopback URL variables above. The extended real-gateway
suite passed with a trace on x86_64: Grok returned `ok`, exit 0 in 542 ms,
and its response/chat request counts increased. No outside DNS or TCP
activity was recorded during that turn. No login was staged.

**Decisions.**

- **How to run the Grok turn?**
  - **Add a Grok case to the live suite, pointing those variables at the fake provider (recommended).**
    - Pros: no billed turn; repeatable in the container qualification workflow beside the other CLIs.
    - Cons: depends on undocumented variables that a Grok bump may rename; may need a fake login file.
  - **One real Grok turn on an isolated profile with the three hosts removed.**
    - Pros: the full real session.
    - Cons: a billed turn and the user's Grok login; not repeatable.

### 2. Settle Cursor without a turn or with a real one

**Problem.** The Cursor SDK (`@cursor/sdk`, in the Cursor bridge) has no CLI
and talks only to Cursor's own API, so the suite could not give it a fake
provider the way it does the CLIs.

**Context.** The SDK bundles Statsig's client. A search of the bridge's
bundle finds its hosts are `featureassets.org`, `prodregistryv2.org`,
`statsigapi.net` and `api.statsigcdn.com`, none of the three removed hosts;
`statsig.com` appears only in documentation links. None of Cursor's required
hosts (`AGENT_NETWORK_DOMAINS_BY_PLATFORM.cursor`) were changed.

The SDK (1.3.1) reads `CURSOR_BACKEND_URL` (default `https://api2.cursor.sh`)
for every backend call, and switches to HTTP/1.1 for an `http:` URL. The two
other places a search of the bundle finds `sentry.io` and `statsig.com` are a
list of known MCP providers (beside `slack.com`, `stripe.com` and others,
used by its MCP network admin check) and a documentation link; neither is a
host the SDK contacts.

**Investigation.** Static at first (2026-11-06). On 2026-11-15 a loopback
fake Cursor backend was built and the SDK pointed at it, first in a
`--network none` container of the qualification image, then in the live
suite. A local agent's turn makes these calls, all to the backend URL:
`POST /auth/exchange_user_api_key` (JSON `{ accessToken }`), `GET /v1/models`
(JSON `{ items: [...] }`, checked against the requested model), unary Connect
RPCs (`DashboardService/GetUserPrivacyMode`,
`GetTeamAdminSettingsOrEmptyIfNotInTeam`, `GetTeamReposOrEmptyIfNotInTeam`,
`ServerConfigService/GetServerConfig`, `AnalyticsService/BootstrapStatsig`,
`AnalyticsService/TrackEvents`), which all accept an empty protobuf message,
then `AgentService/RunSSE` (a Connect server stream) with the run request
sent alongside through `BidiService/BidiAppend` (hex-encoded protobuf in its
field 1). The fake streams two `AgentServerMessage` frames, an
`InteractionUpdate.text_delta` "ok" and `turn_ended`, and the run finishes
with result `ok`. The SDK's Statsig bootstrap and its analytics both go to
the Cursor backend, not to any Statsig host. A run the backend fails with a
Connect `internal` error is retried by the SDK (four attempts, about 16 s)
and then ends in status `error`.

In the live suite (`container-live-telemetry-hosts.test.ts`, restricted
runtime behind its egress gateway with name checks, allowlist
`registry.npmjs.org` only, all three removed hosts and the Sentry ingest
hosts answering `REFUSED`) on omarchy-hp (x86_64, rootful Docker Engine
29.9.1, the test-only network shim) with image
`orkestrator-v2:dev-ca9f88454633` (`sha256:462a044c85be…`, amd64; Cursor SDK
1.3.1, the versions `docker/Dockerfile` pins today for every CLI): the Cursor
turn finished `ok` in 1.8 s, and the failing one ended in `error` in 16.9 s.
The packet trace recorded no DNS lookup and no outside connection during
either Cursor turn (nor during the Pi and Grok turns before them). The suite
passed with the trace (77.0 s) and again without it (73.0 s). No login, no
credential and no real Cursor request was used. Details are in
[container qualification](../../development/container-qualification.md#cursor-sdk-turn-against-a-loopback-cursor-backend-2026-11-15).

**Decisions.**

- **Is a live Cursor turn needed?**
  - **Accept the static evidence and close the task.**
    - Pros: the SDK names none of the removed hosts, and its own Statsig hosts were never on the default list, so the change cannot have removed anything it used.
    - Cons: no observed turn; a future SDK could start using one of them.
  - **One real Cursor turn on an isolated profile, with a packet trace.**
    - Pros: observed behaviour.
    - Cons: a billed turn and the user's Cursor login.
  - **A Cursor SDK turn against a loopback fake Cursor backend in the live suite (recommended; done 2026-11-15).**
    - Pros: an observed turn through the image's own SDK copy with the hosts refused, no login and nothing billed; repeatable in CI beside the other CLIs, and an SDK bump that changes the protocol fails the suite instead of passing silently.
    - Cons: the fake depends on Cursor's undocumented RPC names and field numbers, so an SDK bump may need the fake updated; it exercises the local agent's turn, not cloud agents or tool calls.

### 4. Record native arm64 qualification

**Problem.** The telemetry-host suite is scheduled on both Linux architectures,
but the recorded run establishes only amd64 execution. Wiring a CI step does
not establish an arm64 pass.

**Context.** The address-findings host reports `x86_64`, and the available
qualification image `orkestrator-v2:dev-2462db30da8c` reports `amd64`.
The Container live qualification workflow already schedules this suite on
linux-x64 and linux-arm64.

**Investigation.** No native arm64 run is recorded for this suite. Retain the
workflow's run URL, image architecture and suite result when it executes;
if it fails, inspect and repair the failure before claiming qualification.

**Decisions.**

- **How to obtain arm64 evidence?**
  - **Use the existing native linux-arm64 CI job (recommended).**
    - Pros: exercises the architecture the workflow actually ships and keeps the suite repeatable.
    - Cons: evidence remains pending until that job runs.
  - **Run an arm64 image under emulation on this amd64 host.**
    - Pros: could provide an additional compatibility signal.
    - Cons: does not establish native runner behavior and needs an arm64 image and emulator.

## Assumptions and decisions

### Task 1: Grok through its loopback URL variables

The review fix names Claude Code, Codex, OpenCode, Pi and Grok after the
extended suite passed. Grok uses its loopback API and model-discovery URL
variables with fake keys and an isolated home; the count assertion establishes
that it reached the provider.

### Task 2: a loopback Cursor backend instead of a real turn (2026-11-15)

The no-real-logins and no-billed-turns constraints rule out the real turn,
and the static evidence alone left no observed turn. `CURSOR_BACKEND_URL`
lets the SDK reach a fake backend, so the suite's fake provider now also
serves the Cursor RPCs a local agent's turn makes, under `/cursor`. The test
runs the Cursor bridge's own vendored SDK
(`/opt/cursor-bridge/dist/node_modules/@cursor/sdk`) from a small script
rather than the bridge's HTTP server: the bridge adds nothing that talks to
the network, and the other CLIs are run the same way, directly. It disposes
the agent inside the timed turn so the SDK's analytics flush is part of it.
The fake hand-encodes the few protobuf messages it sends with field numbers
read from the SDK's bundled descriptors, instead of importing the SDK's
private generated classes. The turn asserts the result text and that the
fake served a run, and the error turn asserts the SDK's own error status;
the SDK's retry of a failed run (about 16 s) is inside the 90 s bound.

### Task 2: separate Cursor counters and a strict run match (review fix, 2026-11-15)

Multi Review found two weaknesses in the first version. Cursor's failed runs
were counted under the same `broken` key as the Claude and Codex error turns.
The SDK retries a failed run four times, so the Cursor turn alone met the
final `broken >= 2` check. The fake also sent the RunSSE reply whether or not
the run's request id had arrived through `BidiAppend`, so the comment's claim
that a renumbered request field fails the turn was not true. Cursor runs now
count under `cursor` and `cursor-broken`. The Claude and Codex error turns
each assert their own `broken` delta. The fake answers a run whose request
id is empty, or has not arrived through `BidiAppend` within 5 s, with a
Connect `failed_precondition` error, counts it under `cursor-unmatched`, and
the test asserts that count is zero. A narrower comment would also have
removed the false claim. The strict match was chosen because it lets a
protocol change on either side fail the suite. On omarchy-hp with image
`orkestrator-v2:dev-ca9f88454633` the suite passed (64.4 s). With the
`BidiAppendRequest` field number temporarily changed in the fake, the Cursor
turn failed with that error, as intended.

### Task 4: require observed native execution (unchanged 2026-11-15)

Keep arm64 qualification open until the existing native CI job supplies a
result. The current host and image are amd64; neither the previous amd64 pass
nor CI configuration is substituted for an observed arm64 pass. The
2026-11-15 change edits the suite, which is in the workflow's pull-request
paths, so its pull request schedules the linux-arm64 job too; that run, now
with the Cursor turns, is the evidence this task waits on.

## Related

- [6101](6101-egress-name-checks-platform-coverage.md); 6102 (retired 2026-11-11), whose name-check limits are in [container lifecycle](../../architecture/container-lifecycle.md#name-checks-egress-filter1)
- Security report, M12 (`git show 413bd6219:docs/reports/2-26-10-27-security.md`)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 3, the release-note line for existing installs) moved there on 2026-11-10.
