# Agent-test profiles and the host's Pi default model

Checked against `main` at `459d2944` (2026-10-23).

An agent-test profile authorized for Pi (`dev:test --credential-source pi`)
shared the host's Pi login but not the host's choice of model, so Pi fell back
to a model the login may not be allowed to use. Every live Pi run on such a
host failed before the model answered. The code fix is in (#1177), and the
live Pi coordinator rerun passed on 2026-10-23. Nothing is left in this file.

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
  - `bridges/pi-bridge/src/agent-session-default-model.test.ts`: precedence
    (settings, then fallback, de-duplicated), fallback validation (no
    provider, a leading or trailing slash, the `MAX_MODEL_ID_BYTES` bound),
    project trust, and every entry point that applies the preference:
    `createSession`, `resumeSession`, the retried hydration after an empty
    catalogue, `applyComposerToSession` with no or a stale selection, and a
    real SDK session built by `ensureSession`, carried through
    `dispatchPrompt`. Mutation checks: removing the preference from
    `hydrateComposer` fails the `createSession` test. Removing it from resume,
    from the retried hydration, from `applyComposerToSession` or from the SDK
    attach each fails its own test.
  - `apps/backend/src/core/host-agent-credentials.test.ts`: the variable is
    set only alongside the shared `auth.json`. It is never set in production
    or for a profile that did not authorize Pi. `readPiDefaultModel` rejects a
    lone key, a blank or non-string value, a provider containing `/`, an
    oversized id, malformed JSON, a directory and a settings file one byte
    over the 1 MiB bound (accepting one exactly at it), and accepts a BOM as
    Pi does.
  - `apps/backend/tests/standalone.test.ts` "agent-test startup loads the
    Cursor snapshot and launches Pi with only host auth and its default
    model": a real agent-test backend starts a Pi bridge stub whose
    environment carries `PI_BRIDGE_DEFAULT_MODEL=openai-codex/gpt-5.5` from
    the host `settings.json`.
- The Pi bridge suite preloads `src/testing/test-isolation.ts` (`test:bridge`), which
  points `PI_CODING_AGENT_DIR` at a temporary directory. Session tests no
  longer read the developer's saved default. Tests that build a real SDK
  runtime also stop writing `auth.json` and `models-store.json` into the
  developer's `~/.pi/agent`; four such files (`{}`) appeared in the temporary
  directories on the first isolated run.
- Containers copy the host `~/.pi` subset into `PI_AGENT_DIR`, and that subset
  includes `settings.json`. A container Pi tab with no explicit model
  therefore now starts on the user's saved default too.

## Outstanding work

### Code

1. ~~**Carry the host's Pi default into an agent-test profile.**~~ Done
   2026-10-23. See Current state and the decisions below.

### Qualification

- ~~**A passing `mise run test:agent:coordinator --credential-source pi`**~~
  Done 2026-10-23 (run 3 below), recorded in
  [0024-coordinator-live-conformance.md](../coordinator-and-multi-review/0024-coordinator-live-conformance.md)'s
  read-only, async, family and peer columns.
- **Live runs on 2026-10-23 (this host).** The host's Pi state had changed
  since the original report. `auth.json` held a single `openai` OAuth
  (ChatGPT-backed) login, and `settings.json` saved `openai/gpt-5.5` as the
  default.
  1. First run (`qa-coordinator-2026-10-23T01-10-28-640Z`): 0 passed, 1
     failed. All four scenarios failed at their first turn with `The 'gpt-4'
     model is not supported when using Codex with a ChatGPT account.` The
     profile had run a `bridges/pi-bridge/dist` built before this change
     (no `PI_BRIDGE_DEFAULT_MODEL` in it), so this is the old behaviour:
     the catalogue's first model.
  2. After `bun run --cwd bridges/pi-bridge build`
     (`qa-coordinator-2026-10-23T01-13-05-817Z`): 0 passed, 1 failed. All
     four scenarios failed at their first turn with `The 'gpt-5.5' model is
     not supported when using Codex with a ChatGPT account.` The profile now
     starts on the host's saved default, which is the fix working on the
     real stack. But this host's own saved default is a model its login
     refuses, so the host's `pi` would fail the same way. Passing here needs
     the user to save a model the login runs (`/model` in `pi`; agent-testing
     pins `openai/gpt-6-sol` for this kind of login), then rerun. The host's
     settings were not changed for this run.
  3. After the user saved `"defaultProvider": "openai"`,
     `"defaultModel": "gpt-6.1-sol"` in the host's `settings.json`, on
     `main` at `459d2944` with every bridge rebuilt first
     (`qa-coordinator-2026-10-23T12-26-47-009Z`): **1 passed, 0 failed, 0
     skipped**. All four scenarios passed (read-only, async, family, peer;
     6.5 minutes), and the profile was stopped and reset. The evidence that
     the bridge asked for exactly the host's default:
     - The running Pi bridge's environment held
       `PI_BRIDGE_DEFAULT_MODEL=openai/gpt-6.1-sol` beside
       `PI_BRIDGE_AUTH_FILE` naming the host `auth.json`.
     - Both Pi session files written during the read-only and async scenarios
       recorded a `model_change` to provider `openai`, model `gpt-6.1-sol`.
       Every assistant message in them carried the same provider and model.
       The turns ended in `toolUse` and `stop`, with no error.
     - The provider id survives unchanged from `settings.json` through
       `readPiDefaultModel`, `PI_BRIDGE_DEFAULT_MODEL` and `defaultModelIds`
       to the SDK. The host `auth.json` holds one credential, under `openai`,
       of type `oauth`. In Pi 1.2.0 that is the ChatGPT sign-in for the
       `openai` provider itself (`openaiProvider` in pi-ai registers
       "Sign in with ChatGPT" OAuth beside the API key). `openai-codex` is a
       separate provider that pi-ai now labels "(legacy)". So `openai` is the
       right id for this login, and nothing needed rewriting. The earlier
       failures on `openai/gpt-4` and `openai/gpt-5.5` were the ChatGPT
       backend refusing those models, not a provider-id mismatch.
- The live close-retention run owed by
  [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md)
  waited on a usable Pi model. Earlier on 2026-10-23 its Pi case failed on
  the default `gpt-4` and on an explicit `openai/gpt-5.5` override with the
  same "not supported when using Codex with a ChatGPT account" error. After
  run 3 its Pi case passed with no model override. Its Cursor case failed for
  a reason unrelated to Pi; see 0002.

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
6. **No model override for the live coordinator suite.** A pin like the
   pause suite's `ORKESTRATOR_AGENT_TEST_PAUSE_MODELS` would have let the
   2026-10-23 run pass despite the host's unusable default. It was rejected
   for this change: the suite deliberately launches with "no model or
   reasoning fields", so it qualifies the default path users take. A pin would
   bypass the code this file fixes. Revisit if hosts with unusable saved
   defaults keep blocking qualification.
7. **The host's Pi settings were not edited** to make the live run pass. They
   are the user's, outside the profile, and changing them would change what
   the user's own `pi` runs.
8. **Isolate the Pi bridge suite with a package preload** (Multi Review
   finding). Options: (a) set `PI_CODING_AGENT_DIR` in the shared
   `tests/setup-node.ts`; (b) isolate each test file that creates a session;
   (c) a Pi-bridge-only preload in `test:bridge`. Choice: (c). The shared
   preload also serves backend and desktop tests that read
   `PI_CODING_AGENT_DIR` to locate Pi's directory, so (a) could change them.
   (b) leaves every new file to remember it. Con: a focused `bun test` outside
   `test:bridge` must add the preload; the two files that exercise the
   default model isolate themselves as well.
9. Assumed: Pi stores its default as two keys, `defaultProvider` and
   `defaultModel`, in plain JSON with an optional BOM (true of Pi 1.2.0's
   `SettingsManager`). A provider id never contains `/`.

10. **No code change for the 2026-10-23 rerun.** The rerun was to fix a
    provider-id mismatch if it found one. It found none (run 3), so this change
    is evidence and docs only. A test was not added, because no defect needed
    one, and the verbatim pass-through of `defaultProvider` is already covered
    by `host-agent-credentials.test.ts` and
    `agent-session-default-model.test.ts`. Docs that described a ChatGPT
    login only as `openai-codex` now say that Pi 1.2.0 signs ChatGPT in under
    `openai`. So does a live spec's comment that said `openai/…` needs an API
    key.
11. **Mark the file Finished and keep it for now.** Options: (a) delete it,
    as `docs/README.md` asks once durable behaviour has moved; (b) mark it
    Finished and keep it. Choice: (b), as with 0055. The durable behaviour is
    already in `agent-engines.md`, `credentials-and-models.md` and the Pi
    bridge's `AGENTS.md`. But 0024, 0002, 0031 and 0056 link here for the
    live evidence, and deleting it would break those links in the same change
    that records them. Con: one finished file stays until someone removes it
    with its links.
12. **The open question moved to its own file.** Whether a ChatGPT login with
    no saved default should start on a model it accepts is new work, so per
    `docs/README.md` it went into a new file,
    [0062-pi-chatgpt-login-without-saved-default.md](../agent-engines/0062-pi-chatgpt-login-without-saved-default.md),
    rather than staying open here. 0062 was the first number free on
    `origin/main`, on open PRs and on local worktrees: another worker's branch
    already holds 0061, so 0060 was skipped in case it is also claimed.

## Open questions

- None left. The fresh-install fallback question is
  [0062](../agent-engines/0062-pi-chatgpt-login-without-saved-default.md).

## Related

- [0024-coordinator-live-conformance.md](../coordinator-and-multi-review/0024-coordinator-live-conformance.md)
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md)
- [0056-agent-test-stale-bridge-builds.md](0056-agent-test-stale-bridge-builds.md) (found by the first 2026-10-23 run)
- [0062-pi-chatgpt-login-without-saved-default.md](../agent-engines/0062-pi-chatgpt-login-without-saved-default.md) (the open question this file left)
- [`bridges/pi-bridge/AGENTS.md`](../../../bridges/pi-bridge/AGENTS.md) (models as provider/model pairs, default model)
- [credentials-and-models.md](../../development/credentials-and-models.md) § Pi

## Replaces

- Nothing; found by the 2026-10-22 live coordinator run.

## Multi Review (2026-10-23)

Workflow `action-1f924c0eae2086c4caa691c5f4145ee3`, verdict "with-fixes": no
correctness or security defect, three P2 findings and three coverage gaps. All
six were accepted and fixed. Its automatic fix session stopped before
finishing, having left most of the fixes staged in the worktree; they were
reviewed, kept and completed.

- P2, the fallback comments said "only when the settings name no default". The
  code also falls back when the saved default is not served by a signed-in
  provider. Fixed in `config.ts`, `host-agent-credentials.ts`,
  `agent-engines.md` and `credentials-and-models.md`.
- P2, the pause suite's comment (`paused-interactions-live.spec.ts`) still said
  a profile does not receive the host default. Fixed.
- P2, the session tests read the developer's real Pi settings. Fixed by the
  package preload (decision 8) and per-file isolation in
  `agent-session.test.ts` and `agent-session-default-model.test.ts`.
- Gaps: preference wiring through resume, retried hydration, apply and attach
  to prompt; fallback slash and byte-bound cases; the settings-size bound.
  Each is covered now (see Evidence).
- The review's own `mise run test` failed on timeouts in owners this change
  does not touch (web long transcript, backend terminal history, desktop
  fixture-tree digest, root Pi vendor staging, disk report). These are the
  same kind as case 0694.
