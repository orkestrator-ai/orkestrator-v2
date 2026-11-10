# Telemetry hosts: Grok and Cursor turns, and the release note

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`. Left by to-do 6100, which
removed `sentry.io`, `statsig.anthropic.com` and `statsig.com` from the
default allowlist after Claude Code, Codex, OpenCode and Pi each finished
turns against a fake provider without them
([qualification record](../../development/container-qualification.md#agent-clis-without-telemetry-hosts-on-rootful-linux-engine-2026-11-06)).

### Tasks

1. **Run a Grok turn without the telemetry hosts**: a Grok Build turn in a restricted container with the three hosts refused, against a fake provider. Status: done. (Review follow-up, 2026-11-06.)
2. **Settle Cursor without a turn or with a real one**: decide whether the static evidence is enough for the Cursor SDK, or run one real turn. Status: open.
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
and talks only to Cursor's own API, so the suite cannot give it a fake
provider.

**Context.** The SDK bundles Statsig's client. A search of the bridge's
bundle finds its hosts are `featureassets.org`, `prodregistryv2.org`,
`statsigapi.net` and `api.statsigcdn.com`, none of the three removed hosts;
`statsig.com` appears only in documentation links. None of Cursor's required
hosts (`AGENT_NETWORK_DOMAINS_BY_PLATFORM.cursor`) were changed.

**Investigation.** Static only. No Cursor turn was run.

**Decisions.**

- **Is a live Cursor turn needed?**
  - **Accept the static evidence and close the task (recommended).**
    - Pros: the SDK names none of the removed hosts, and its own Statsig hosts were never on the default list, so the change cannot have removed anything it used.
    - Cons: no observed turn; a future SDK could start using one of them.
  - **One real Cursor turn on an isolated profile, with a packet trace.**
    - Pros: observed behaviour.
    - Cons: a billed turn and the user's Cursor login.

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

### Tasks 1 and 2: retain the live qualification gaps

The review fix names Claude Code, Codex, OpenCode, Pi and Grok after the
extended suite passed. Grok uses its loopback API and model-discovery URL
variables with fake keys and an isolated home; the count assertion establishes
that it reached the provider. The Cursor SDK has no fake-provider route in
this suite and is not claimed as a live pass. The original no-real-logins and no-billed-turns constraints still apply;
this review request does not waive them. Static evidence stays recorded above,
and Cursor live coverage remains open.

### Task 4: require observed native execution

Keep arm64 qualification open until the existing native CI job supplies a
result. The current host and image are amd64; neither the previous amd64 pass
nor CI configuration is substituted for an observed arm64 pass.

## Related

- [6101](6101-egress-name-checks-platform-coverage.md), [6102](6102-egress-name-check-residual-channels.md)
- Security report, M12 (`git show 413bd6219:docs/reports/2-26-10-27-security.md`)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 3, the release-note line for existing installs) moved there on 2026-11-10.
