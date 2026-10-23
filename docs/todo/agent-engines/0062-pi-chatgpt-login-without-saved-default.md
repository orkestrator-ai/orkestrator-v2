# Pi on a ChatGPT login with no saved default starts on a refused model

Checked against `main` at `459d2944` (2026-10-23).

Split out of the open question left by
[0054-agent-test-pi-default-model.md](../cross-cutting/0054-agent-test-pi-default-model.md).
A Pi tab with no explicit model starts on Pi's saved default, then on
`PI_BRIDGE_DEFAULT_MODEL`, then on the catalogue's first model
(`defaultModelIds` in `bridges/pi-bridge/src/agent-session.ts`). A user who
signed in to Pi with ChatGPT and never saved a default reaches that last
step. There the first model is one the login refuses, so the tab's first
prompt fails before the model answers.

## Current state

- In Pi 1.2.0, "Sign in with ChatGPT" is an OAuth login on the `openai`
  provider itself (`openaiProvider` in `@earendil-works/pi-ai`), stored under
  `openai` in `auth.json`. The older `openai-codex` provider is still there,
  and pi-ai now labels it "(legacy)".
- With that login, the `openai` catalogue lists the whole OpenAI chat
  catalogue (it hides only classifier models), starting with `gpt-4`. The
  ChatGPT backend refuses several of them with `The '<model>' model is not
  supported when using Codex with a ChatGPT account`. Seen live on
  2026-10-23: `gpt-4` and `gpt-5.5` were refused, and `gpt-6.1-sol` ran
  ([0054](../cross-cutting/0054-agent-test-pi-default-model.md), runs 1–3).
  A legacy `openai-codex` login lists `gpt-5.3-codex-spark` first and
  refuses that too.
- Pi's own fallback table (`defaultModelPerProvider` in pi-coding-agent's
  `model-resolver.js`) names `gpt-5.5` for `openai` and `gpt-6.1-sol` for
  `openai-codex`. The table is not exported from the package, so the bridge
  cannot reuse it (0054, decision 3).
- Workarounds today: pick a model in the tab's picker, or save one with
  `/model` in `pi`, which the bridge then honours.

## Outstanding work

### Code

1. **Start a ChatGPT-backed Pi login on a model it runs** when no default is
   saved. Candidates, none chosen yet:
   - (a) Ask Pi upstream to export `defaultModelPerProvider` or
     `findInitialModel`, or to order or filter a subscription login's
     catalogue to the models it accepts. The bridge would then follow Pi.
   - (b) After a turn fails with the "not supported when using Codex with a
     ChatGPT account" error, steer the picker away from that model. This
     needs a recognisable error, not message matching.
   - (c) Keep a small bridge-side preference per subscription provider. It
     drifts from Pi on every release, which is why 0054 rejected it.

### Qualification

- A fresh agent-test profile whose host has a ChatGPT `openai` login and no
  saved default should answer its first Pi prompt with no model override.

## Constraints and rationale

- An explicit selection and a saved default must keep winning. This is only
  about the last fallback.
- Never write the user's `~/.pi` settings to choose a model for them.

## Open questions

- Which of (a)–(c)? (a) is cleanest, but it depends on Pi's release cadence.

## Needs verification

- Whether `pi` in a terminal, on the same fresh login, also starts on
  `gpt-5.5` and fails the same way. Its table says so; this was not run.

## Related

- [0054-agent-test-pi-default-model.md](../cross-cutting/0054-agent-test-pi-default-model.md)
- [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md)
- [credentials-and-models.md](../../development/credentials-and-models.md) § Pi, Default model

## Replaces

- The open question in 0054 ("Should Pi's own fallback be treated as a
  product issue too?").
