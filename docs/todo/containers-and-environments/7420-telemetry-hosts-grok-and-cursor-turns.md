# Telemetry hosts: Grok and Cursor turns, and the release note

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`. Left by to-do 6100, which
removed `sentry.io`, `statsig.anthropic.com` and `statsig.com` from the
default allowlist after Claude Code, Codex, OpenCode and Pi each finished
turns against a fake provider without them
([qualification record](../../development/container-qualification.md#agent-clis-without-telemetry-hosts-on-rootful-linux-engine-2026-11-06)).

### Tasks

1. **Run a Grok turn without the telemetry hosts**: a Grok Build turn in a restricted container with the three hosts refused, against a fake provider. Status: open.
2. **Settle Cursor without a turn or with a real one**: decide whether the static evidence is enough for the Cursor SDK, or run one real turn. Status: open.
3. **Say so in the next release notes**: new installs no longer allow the three hosts; stored lists keep them. Status: open.

### 1. Run a Grok turn without the telemetry hosts

**Problem.** `apps/backend/tests/container-live-telemetry-hosts.test.ts`
runs Claude Code, Codex, OpenCode and Pi, but not Grok: Grok Build has no
documented way to point a turn at a local provider, and the suite does not
use real logins.

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

**Investigation.** Not run. The suite's fake provider already serves OpenAI
Chat Completions and Responses on the runtime's loopback, which the xAI API
resembles, but whether `grok agent` accepts an API key from the environment
and these base URLs without a login was not tried.

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

### 3. Say so in the next release notes

**Problem.** A stored allowlist is never changed to match a new default, so
existing installs keep the three hosts until their users remove them, and
nothing tells them they can.

**Context.** To-do 6100 task 2 changed only `DEFAULT_ALLOWED_DOMAINS` and the
generated image fallback (`docker/default-allowed-domains`). Release notes are
written when a release is cut; this repository keeps no unreleased-notes file.

**Investigation.** Nothing written yet.

**Decisions.**

- **What do existing installs get?**
  - **A release-note line only (recommended).** "New installs no longer allow `sentry.io`, `statsig.anthropic.com` and `statsig.com` in restricted containers; no agent needs them. Existing allowlists keep them; remove them in Settings to close the channel."
    - Pros: matches the rule that a stored list is never narrowed behind the user.
    - Cons: the channel stays open on installs whose users do not read the notes.
  - **Remove them from stored lists on upgrade.**
    - Pros: closes the channel everywhere.
    - Cons: edits the user's own list, which nothing else does; a user who added them on purpose loses them.

## Related

- [6101](6101-egress-name-checks-platform-coverage.md), [6102](6102-egress-name-check-residual-channels.md)
- [Security report, M12](../../reports/2-26-10-27-security.md#m12-egress-firewall-limitations-design)
