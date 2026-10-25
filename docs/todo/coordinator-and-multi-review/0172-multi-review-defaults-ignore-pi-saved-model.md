# Multi Review defaults ignore Pi's saved default model

Checked against `main` at `00a0cb82` (2026-10-25).

Found by the live coordinator `status` scenario
([0024](0024-coordinator-live-conformance.md)). A Multi Review whose rows
come from the saved defaults (the Multi Review button, or a coordinator's
`launch_multi_review` without rows) resolves a Pi row with no model saved in
Orkestrator to the first model in Pi's catalogue. A Pi tab with no model
starts on Pi's own saved default instead. On a ChatGPT-backed Pi login those
differ, and the first catalogue model is one the login refuses, so every Pi
reviewer, the preparation turn and the Fix fail at once.

## Current state

- `multiReviewDefaultRows` → `concreteRow`
  (`apps/backend/src/core/coordinator-launch-defaults.ts`) takes the action
  default's model, else the platform settings' model, else `offered[0]` of
  the catalogue. `resolveCatalogModelId` (`packages/protocol/src/model-id.ts`)
  returns nothing for an absent model, so `offered[0]` wins.
- The Pi bridge starts a tab with no explicit model on Pi's saved default,
  then `PI_BRIDGE_DEFAULT_MODEL`, then the catalogue's first model
  (`defaultModelIds` in `bridges/pi-bridge/src/agent-session.ts`; 0054). So a
  Pi worker launched with no model runs, and a Pi Multi Review row does not.
- Seen live on 2026-10-25 (macOS, Pi 1.2.0, host Pi default
  `openai/gpt-6.1-sol` on a ChatGPT `openai` login, no Pi model saved in
  Orkestrator): the coordinator's Multi Review resolved every row to
  `openai/gpt-4` and failed with "The preparation session failed: OpenAI API
  error (400)". In the same run, Pi workers with no model ran on the host
  default and passed. Run `qa-coordinator-2026-10-25T17-01-44-657Z`, profile
  `qa-coordinator-pi-c7b5e0a4` (local, ignored).
- Workaround: save a Pi model in Orkestrator settings, or name the rows.

## Outstanding work

### Code

1. **Resolve an unset Pi row to what a Pi tab would start on.** Options, none
   chosen yet:
   - (a) Leave the row's model unset (`default`) and let the reviewer
     session start on the bridge's default, as a worker does. Needs the
     review records and the launch dialog to accept an unresolved model.
   - (b) Have the catalogue mark the bridge's starting model (a default flag
     on `AgentModel`, or ordering it first), and prefer it in `concreteRow`.
     Helps every platform whose session default is not the first entry.
   - (c) Read the bridge's resolved default at launch and write it into the
     row. Pins it at launch time, which is what the dialog shows anyway.
2. Check whether Build Pipeline defaults (`buildPipelineInputWithDefaults`)
   and other `concreteRow` callers have the same gap, and fix them together.

### Qualification

- With no Pi model saved in Orkestrator and a ChatGPT-backed Pi login whose
  first catalogue model is refused, a Multi Review from the saved defaults
  runs. The live `status` scenario on Pi is the check
  (`mise run test:agent:coordinator --credential-source pi --scenario status`).

## Constraints and rationale

- An explicit row, an action default and a saved platform model keep winning;
  this is only about the last fallback.
- Never write the user's `~/.pi` settings, or Orkestrator's, to work around
  it in the product.
- The live suite does not work around it either: it would hide the bug the
  scenario found.

## Open questions

- None yet.

## Related

- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
- [0062-pi-chatgpt-login-without-saved-default.md](../agent-engines/0062-pi-chatgpt-login-without-saved-default.md)
  (the same refused first model, for a Pi tab with no saved default at all)
- [0054-agent-test-pi-default-model.md](../cross-cutting/0054-agent-test-pi-default-model.md)

## Replaces

- Nothing; new on 2026-10-25.
