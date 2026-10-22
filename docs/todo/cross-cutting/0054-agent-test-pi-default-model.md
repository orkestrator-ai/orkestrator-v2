# Agent-test profiles and the host's Pi default model

Checked against `main` at `b83ae534` (2026-10-22).

An agent-test profile authorized for Pi (`dev:test --credential-source pi`)
shares the host's Pi login but not the host's choice of model, so Pi falls
back to a model the login may not be allowed to use, and every live Pi run on
such a host fails before the model answers.

## Current state

- `applyPiHostCredentialEnvironment` (`apps/backend/src/core/host-agent-credentials.ts`)
  hands the Pi bridge the host's `auth.json` alone through
  `PI_BRIDGE_AUTH_FILE`. Settings, `models.json`, `mcp.json` and extensions
  stay in the profile's own `~/.pi/agent`, deliberately (see "Agent-test
  profiles carry the host's Pi and Cursor logins" in
  [0024-coordinator-live-conformance.md](../coordinator-and-multi-review/0024-coordinator-live-conformance.md)).
- The host's `~/.pi/agent/settings.json` names its default
  (`defaultProvider`, `defaultModel`). The profile's settings do not, so Pi
  picks its own default for the signed-in provider.
- Live on 2026-10-22 (this host: Pi 1.2.0, `auth.json` holding
  `openai-codex` and `opencode-go`, host default `openai-codex/gpt-5.5`), the
  live coordinator read-only case on Pi ended its first turn with
  `Codex error: The 'gpt-5.3-codex-spark' model is not supported when using
  Codex with a ChatGPT account.` A user's own local Pi tab is not affected,
  because a local worktree reads the user's real `~/.pi/agent`.

## Outstanding work

### Code

1. **Carry the host's Pi default into an agent-test profile.** When Pi is
   authorized, seed the profile's Pi settings with the host's
   `defaultProvider` and `defaultModel` (only those keys, and only when the
   profile has not chosen its own), or have the live suites pick a model from
   the profile's catalogue that the login can use. Keep the rest of the host
   settings out, for the reasons the 0024 decision gives.

### Qualification

- Rerun `mise run test:agent:coordinator --credential-source pi` once this is
  fixed; that run is owed by
  [0024-coordinator-live-conformance.md](../coordinator-and-multi-review/0024-coordinator-live-conformance.md).

## Constraints and rationale

- Copying the whole host Pi directory was rejected in 0024: test runs would
  load host extensions and could rewrite host settings. Seeding two keys does
  not reopen that.

## Open questions

- Should Pi's own fallback be treated as a product issue too? A fresh install
  whose only Pi provider is a ChatGPT-backed `openai-codex` login would meet
  the same unsupported default; whether Pi upstream or Orkestrator's model
  picker should prevent that is undecided.

## Related

- [0024-coordinator-live-conformance.md](../coordinator-and-multi-review/0024-coordinator-live-conformance.md)
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md)
- [`bridges/pi-bridge/AGENTS.md`](../../../bridges/pi-bridge/AGENTS.md) (models as provider/model pairs)

## Replaces

- Nothing; found by the 2026-10-22 live coordinator run.
