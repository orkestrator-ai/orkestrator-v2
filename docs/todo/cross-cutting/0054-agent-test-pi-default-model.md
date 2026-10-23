# Agent-test profiles and the host's Pi default model

Checked against `main` at `06297124` (2026-10-23).

An agent-test profile authorized for Pi (`dev:test --credential-source pi`)
shared the host's Pi login but not the host's choice of model, so Pi fell back
to a model the login may not be allowed to use. Every live Pi run on such a
host failed before the model answered. The code fix is in; the live rerun is
still owed.

## Current state

- **Fixed (2026-10-23): the bridge now starts on Pi's saved default.** The
  root cause was wider than agent-test. With no explicit model, the bridge
  started every session on the catalogue's first model
  (`resolveModel(undefined)` returned `available[0]`, and `hydrateComposer`
  picked `models[0]`). It then passed that model to the SDK explicitly, so
  Pi's own `findInitialModel`, which reads `defaultProvider`/`defaultModel`,
  never ran. The saved default was ignored in every Pi tab with no explicit
  model, not only in agent-test. On a ChatGPT-backed `openai-codex` login the
  first model is `gpt-5.3-codex-spark`, which is exactly the 2026-10-22
  failure. Now `defaultModelIds` (`bridges/pi-bridge/src/agent-session.ts`)
  lists, best first:
  1. Pi's saved default from `settings.json`. Project settings count only when
     the session trusts the project (`piResourceLoaderPolicy`).
  2. `PI_BRIDGE_DEFAULT_MODEL` (`fallbackDefaultModelId` in `config.ts`).
  3. The catalogue's first model, as before.

  `hydrateComposer` and `resolveModel` (`models.ts`) take the first preferred
  id a signed-in provider serves. An explicit selection still wins.
- **Fixed (2026-10-23): the host's default travels with the host's login.**
  `applyPiHostCredentialEnvironment`
  (`apps/backend/src/core/host-agent-credentials.ts`) still hands the bridge
  only the host `auth.json` through `PI_BRIDGE_AUTH_FILE`. When it does, it
  now also reads `defaultProvider` and `defaultModel`, and nothing else, from
  the host's `settings.json` (`readPiDefaultModel`), and passes them as
  `PI_BRIDGE_DEFAULT_MODEL`. Production and unauthorized profiles get neither
  variable, and an inherited one is deleted. The profile's own `~/.pi/agent`
  is never written.
- Evidence (all local, no provider turn):
  - `bridges/pi-bridge/src/models.test.ts` § "default model": a Spark-first
    catalogue opens on the preferred `openai-codex/gpt-5.5`. An explicit
    selection is kept. With no preference the first model is still the
    fallback. `resolveModel` falls back to the first preferred model offered.
  - `bridges/pi-bridge/src/agent-session.test.ts` § "default model":
    precedence (settings, then fallback, de-duplicated), project trust, and
    `createSession` starting on the default instead of Spark. Mutation check:
    removing the preference from `hydrateComposer` fails "starts a new session
    on the default instead of the catalogue's first model".
  - `apps/backend/src/core/host-agent-credentials.test.ts`: the variable is
    set only alongside the shared `auth.json`. It is never set in production
    or for a profile that did not authorize Pi. `readPiDefaultModel` rejects a
    lone key, a blank or non-string value, a provider containing `/`, an
    oversized id, malformed JSON and a directory, and accepts a BOM as Pi does.
  - `apps/backend/tests/standalone.test.ts` "agent-test startup loads the
    Cursor snapshot and launches Pi with only host auth and its default
    model": a real agent-test backend starts a Pi bridge stub whose
    environment carries `PI_BRIDGE_DEFAULT_MODEL=openai-codex/gpt-5.5` from
    the host `settings.json`.
- Containers copy the host `~/.pi` subset into `PI_AGENT_DIR`, and that subset
  includes `settings.json`. A container Pi tab with no explicit model
  therefore now starts on the user's saved default too.

## Outstanding work

### Code

1. ~~**Carry the host's Pi default into an agent-test profile.**~~ Done
   2026-10-23. See Current state and the decisions below.

### Qualification

- Rerun `mise run test:agent:coordinator --credential-source pi`; the run is
  owed by
  [0024-coordinator-live-conformance.md](../coordinator-and-multi-review/0024-coordinator-live-conformance.md).
  It needs a host whose Pi login is the failing kind (a ChatGPT-backed
  `openai-codex` login with a saved default it can run). On 2026-10-23 this
  host's Pi state had changed: `auth.json` held only `openai` and the saved
  default was `openai/gpt-5.5`. A run here cannot reproduce the
  `openai-codex` failure, so it would not prove the fix. Record the result
  in 0024's read-only, async, family and peer rows.

## Assumptions and decisions

1. **Fix the bridge's model choice, not only the profile.**
   - Options: (a) seed the profile's `settings.json` with the host's two keys
     and change nothing else; (b) have the live suites pick a model from the
     catalogue; (c) make the bridge honour Pi's saved default, then carry the
     host's default to agent-test profiles.
   - Choice: (c).
   - Why: (a) alone fixes nothing. The bridge always passed an explicit model,
     the catalogue's first, so the SDK never read `defaultProvider` or
     `defaultModel` from any settings file. (b) leaves real users' default-less
     tabs on a model their login may refuse, and every suite would have to
     know which models each login accepts.
   - Pros: a native Pi tab now starts where `pi` in a terminal does, in
     production, containers and agent-test.
   - Cons: a user-visible change. A Pi tab with no explicit model, whose user
     saved a different default in `pi`, now opens on that default instead of
     the catalogue's first model. That is the intended behaviour, but it is
     new.
2. **Carry the host default as an environment variable, not a file seed.**
   - Options: (a) write the two keys into the profile's
     `~/.pi/agent/settings.json` at `dev:test` start (`profile-io.ts`, like the
     Codex and OpenCode snapshots); (b) read them at each bridge start in
     `applyPiHostCredentialEnvironment` and pass `PI_BRIDGE_DEFAULT_MODEL`.
   - Choice: (b).
   - Why: the policy for what a profile receives from the host's Pi directory
     already lives in that function, and the catalogue probe uses the same
     one. Reading at launch keeps the value current. A file seed would need
     provenance tracking: to tell a seeded default from one the profile chose,
     to refresh it when the host default changes, and to drop it when Pi is no
     longer authorized.
   - Pros: no write into a file Pi also writes. Revocation and host changes
     take effect at the next bridge start. "Only when the profile has not
     chosen its own" is decided per session, because the profile's saved
     default comes first.
   - Cons: one more bridge environment variable. A `pi` run in a terminal tab
     inside the profile does not see the host default, but that tab does not
     have the host login either.
3. **Keep the catalogue's first model as the last resort.** Pi's own fallback
   list (`defaultModelPerProvider` in `findInitialModel`) is not exported from
   the SDK. Copying it would drift from Pi on every release. Rejected for now.
4. **A project's saved default counts only for a trusted project.** Reading
   `<cwd>/.pi/settings.json` unconditionally would let a cloned repository
   pick the model of a read-only coordinator session. It can only pick a model
   the user is signed in to, but trust is the rule the bridge already applies
   to project resources.
5. **The default travels only with the login.** No `auth.json` means no
   `PI_BRIDGE_DEFAULT_MODEL`. Without the login the default names a provider
   the profile cannot use.
6. Assumed: Pi stores its default as two keys, `defaultProvider` and
   `defaultModel`, in plain JSON with an optional BOM (true of Pi 1.2.0's
   `SettingsManager`). A provider id never contains `/`.

## Open questions

- Should Pi's own fallback be treated as a product issue too? With the bridge
  fix, a user who saved a default is covered. A fresh install with no saved
  default whose only provider is a ChatGPT-backed `openai-codex` login still
  starts on the catalogue's first model, which that login refuses. Whether Pi
  upstream should order or filter its catalogue, or Orkestrator's picker should
  learn which models a login accepts, is still undecided.

## Related

- [0024-coordinator-live-conformance.md](../coordinator-and-multi-review/0024-coordinator-live-conformance.md)
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md)
- [`bridges/pi-bridge/AGENTS.md`](../../../bridges/pi-bridge/AGENTS.md) (models as provider/model pairs, default model)
- [credentials-and-models.md](../../development/credentials-and-models.md) § Pi

## Replaces

- Nothing; found by the 2026-10-22 live coordinator run.
