# Pi on a ChatGPT login with no saved default starts on a refused model

Checked against `main` at `930189337` (2026-10-26), Pi SDK and CLI 1.4.0.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Last-resort model for a ChatGPT login**: start a ChatGPT-backed Pi login with no saved default on a model it runs. Status: done.
2. **Bridge-level live check on an `openai` ChatGPT login**: run the opt-in live test with a current `openai` OAuth credential. Status: blocked (no `openai` ChatGPT login on any known host).
3. **Agent-test path live run**: a fresh agent-test profile on a host with an `openai` ChatGPT login and no saved default answers its first Pi prompt. Status: blocked (needs such a host).
4. **Terminal `pi` on a fresh `openai` ChatGPT login**: confirm whether the terminal starts on the refused `gpt-5.5`. Status: partly done (legacy login answered live; `openai` answered from code only).

### 1. Last-resort model for a ChatGPT login

**Problem.** A user signed in to Pi with ChatGPT and no saved default used to start on the catalogue's first model (`openai/gpt-4`), which the ChatGPT backend refuses, so the first prompt failed.

**Context.** Split from todo 0054. The file's decision 1 chose option (d): use pi-ai's `openai-codex` catalogue as the list of models the ChatGPT backend serves.

**Investigation.** Done and still in place. `lastResortModelId` is at `bridges/pi-bridge/src/models.ts:391`, `chatGptLoginModelIds` at `bridges/pi-bridge/src/models.ts:369`, with the two hard-coded provider ids at `bridges/pi-bridge/src/models.ts:349` and `:355`. It is used by `resolveModel` (`bridges/pi-bridge/src/models.ts:313`, call at `:334`) and `hydrateComposer` (`bridges/pi-bridge/src/models.ts:483`, helper at `:510`). Tests: `bridges/pi-bridge/src/models.test.ts:313` (fake runtime) and `:465` (pinned SDK), `bridges/pi-bridge/src/agent-session-default-model.test.ts:295`. Landed in `f1223e0b` (#1283). The pin is still 1.4.0 (`bridges/pi-bridge/package.json:16-17`), and Pi's private table still names `openai: "gpt-5.5"` and `"openai-codex": "gpt-6.1-sol"` (`bridges/pi-bridge/node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js:10-16`), so the premise holds. The upgrade runbook asks for a recheck on each Pi bump (`docs/development/upgrade-agents.md`, Pi section).

**Decisions.** None: decided and built (decision 1 and 2 in this file); the pinned-SDK test guards the premise on a bump.

### 2. Bridge-level live check on an `openai` ChatGPT login

**Problem.** The fix has run live only on a legacy `openai-codex` login. The current `openai` OAuth login uses a different OAuth client and token scope, so that evidence does not cover it.

**Context.** The file's Qualification steps 1 and 2. The constraint is that the user's `~/.pi` must not be changed for a test.

**Investigation.** The opt-in test exists: `bridges/pi-bridge/src/agent-session-chatgpt-live.test.ts:11` (skipped unless `ORKESTRATOR_PI_CHATGPT_LIVE=1`). It reads `ORKESTRATOR_PI_CHATGPT_AUTH_FILE` or `~/.pi/agent/auth.json` (`:14-15`), copies only the `openai` credential with its refresh token replaced (`:53`), and checks subscription detection and `openai/gpt-4` first (`:79-80`). The command is documented in `docs/development/testing-guide.md:363-386`. This test replaces the hand-written script in Qualification step 2: pointing `ORKESTRATOR_PI_CHATGPT_AUTH_FILE` at the disposable login from step 1 does the same work. This host's `~/.pi/agent/auth.json` still holds only `openai-codex` (the `opencode-go` key the file mentions is no longer there), so the test would stop at its preflight (`:19-27`).

**Decisions.**

- **How to get an `openai` ChatGPT credential?**
  - **Disposable login, then the opt-in test (recommended).** Run the pinned `pi` `/login` → OpenAI → "Sign in with ChatGPT" under a temporary `HOME` and `PI_CODING_AGENT_DIR`, then run the documented test with `ORKESTRATOR_PI_CHATGPT_AUTH_FILE` pointing at it.
    - Pros: never touches the user's `~/.pi`; reuses the checked-in test instead of a one-off script; repeatable on every Pi bump.
    - Cons: needs a person to complete the browser sign-in; a second ChatGPT OAuth grant may appear on the user's account and should be revoked afterwards.
  - **Wait for a host that already has an `openai` login.**
    - Pros: no extra sign-in.
    - Cons: no such host is known; the item stays open indefinitely.
- **Keep the manual script in Qualification step 2?**
  - **Replace it with the opt-in test (recommended).** Treat step 2 as "run the opt-in test against the step 1 auth file".
    - Pros: one procedure; the test already asserts every expectation step 2 lists.
    - Cons: none beyond editing the step's wording when it is closed.
  - **Keep both.**
    - Pros: the script exercises the same calls without bun's test harness.
    - Cons: two procedures that can drift.

### 3. Agent-test path live run

**Problem.** Nobody has shown that an agent-test profile on an `openai` ChatGPT host with no saved default reaches the fallback and answers.

**Context.** Qualification step 3; needs a fresh bridge build (todo 0056, retired on 2026-10-29; see [agent-testing.md](../../development/agent-testing.md#bridge-builds)). The file already allows closing with a caveat if no such host exists.

**Investigation.** The agent-test profile hands the host's Pi credential and saved default to the bridge through `applyPiHostCredentialEnvironment` (`apps/backend/src/core/host-agent-credentials.ts:97-114`): `PI_BRIDGE_AUTH_FILE` points at the host's `auth.json` and `PI_BRIDGE_DEFAULT_MODEL` carries any saved default. This host's `settings.json` still saves `openai-codex` / `gpt-5.5`, so a profile here would start on that refused saved default, not on the fallback. `mise run test:agent:coordinator` exists (`mise.toml:271`). Because the profile reads the host file directly, a disposable login cannot be swapped in without changing the host's `~/.pi`, which the constraints forbid.

**Decisions.**

- **Run it, or close on the bridge-level evidence?**
  - **Close with the caveat once task 2 passes (recommended).** Record task 2's result as the closest evidence, as Qualification step 3 already permits.
    - Pros: the profile path adds only credential plumbing that is already unit-tested; avoids changing any host's `~/.pi`.
    - Cons: the end-to-end agent-test path stays unproved for this login.
  - **Run it on a host that genuinely has an `openai` login and no saved default.**
    - Pros: full end-to-end proof.
    - Cons: no such host is known; changing a host to create one breaks the constraints.
- **Order relative to task 2?**
  - **After task 2 (recommended).**
    - Pros: task 2 is cheaper and decides whether this is needed at all.
    - Cons: none.
  - **Independently.**
    - Pros: none in practice.
    - Cons: may waste a run that task 2 would have made unnecessary.

### 4. Terminal `pi` on a fresh `openai` ChatGPT login

**Problem.** If the terminal `pi` also starts on `openai/gpt-5.5` and fails, users see the same failure outside the bridge, which the bridge fix does not cover.

**Context.** Needs verification item. The legacy half was answered live on 2026-10-26.

**Investigation.** By code the answer is still yes: `findInitialModel` walks `defaultModelPerProvider` in key order and `openai: "gpt-5.5"` precedes `openai-codex` (`bridges/pi-bridge/node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js:10-16`, walk at `:416-417` and `:462-463`). The bridge cannot change the terminal's choice without writing `~/.pi/agent/settings.json`, which the constraints forbid.

**Decisions.**

- **What to do with the answer?**
  - **Confirm in passing during task 2, record it, and report upstream if it fails (recommended).** Run `pi -p` with no `--model` in the same disposable directory.
    - Pros: costs one extra command on a login that exists anyway; an upstream report is the only fix that reaches the terminal.
    - Cons: depends on task 2 happening.
  - **Treat the code reading as sufficient and close it now.**
    - Pros: closes the item without a login.
    - Cons: the backend's refusal list can change server-side; the code reading cannot prove the live outcome.

Split out of the open question left by todo 0054 (retired on 2026-10-29; see
[credentials-and-models.md](../../development/credentials-and-models.md#default-model)).
A Pi tab with no explicit model starts on Pi's saved default, then on
`PI_BRIDGE_DEFAULT_MODEL`, then on a last resort (`defaultModelIds` in
`bridges/pi-bridge/src/agent-session.ts`, `lastResortModelId` in
`bridges/pi-bridge/src/models.ts`). A user who signed in to Pi with ChatGPT
and never saved a default reaches that last step. Until 2026-10-26 it was the
catalogue's first model, which that login refuses, so the tab's first prompt
failed before the model answered. The code fix is in. What is left is a live
run on an `openai` ChatGPT login, which this host does not have.

## Current state

- In Pi 1.2.0 and later, "Sign in with ChatGPT" is an OAuth login on the
  `openai` provider itself (`openaiProvider` in `@earendil-works/pi-ai`),
  stored under `openai` in `auth.json`, with `isSubscription: true`. Its
  tokens go to `api.openai.com` with the `chatgpt.tokens.use.direct` scope.
  The older `openai-codex` provider is still there, labelled "(legacy)"; it
  talks to `chatgpt.com/backend-api` and has its own OAuth client.
- With an `openai` ChatGPT login, the catalogue lists the whole OpenAI chat
  catalogue (only classifier models are hidden), starting with `gpt-4`.
  Confirmed against the pinned 1.4.0 SDK on 2026-10-26 (offline, fake
  credential): 42 models, `openai/gpt-4` first,
  `isUsingSubscription("openai")` true. The ChatGPT backend refuses several of
  them with `The '<model>' model is not supported when using Codex with a
  ChatGPT account`. Seen live on 2026-10-23: `gpt-4` and `gpt-5.5` were
  refused, and `gpt-6.1-sol` ran
  (todo 0054, runs 1–3).
- A legacy `openai-codex` login no longer starts on a refused model. Pi 1.4.0
  dropped `gpt-5.3-codex-spark` from that catalogue, which now lists
  `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-luna`,
  `gpt-6-sol` and `gpt-6.1-sol`. The pi-ai generator sorts it by id, so the
  newest family comes last.
- Pi's own fallback table (`defaultModelPerProvider` in pi-coding-agent's
  `dist/core/model-resolver.js`, still not exported in 1.4.0; the package's
  `exports` map has only `.` and `./rpc-entry`) names `gpt-5.5` for `openai`
  and `gpt-6.1-sol` for `openai-codex`. `findInitialModel` walks the table in
  key order, and `openai` comes before `openai-codex`. So following Pi
  upstream would not fix an `openai` ChatGPT login: Pi's own pick for it is a
  model it refuses.
- **Fixed (2026-10-26): the last resort skips the refused first model.**
  `lastResortModelId` (`bridges/pi-bridge/src/models.ts`) replaces "the first
  available model" in both `resolveModel` (the SDK attach and
  `applyComposerToSession`) and `hydrateComposer` (create, resume, retried
  hydration). When the first model belongs to a ChatGPT subscription login,
  meaning `openai` with an OAuth subscription credential or the legacy
  `openai-codex` (`chatGptLoginModelIds`), the session starts on the newest
  id of pi-ai's ChatGPT-backend catalogue (the `openai-codex` provider's
  built-in list, read through `ModelRuntime.getModels`) that the login's
  provider offers. On Pi 1.4.0 that is `openai/gpt-6.1-sol` (or
  `openai-codex/gpt-6.1-sol`). Every other case keeps the first model: an
  API key on `openai`, any other provider first in the catalogue, a catalogue
  that offers none of the backend's ids, or a runtime that cannot answer.
  An explicit selection, Pi's saved default and `PI_BRIDGE_DEFAULT_MODEL`
  still come first, even when they name a model the login refuses.
- Evidence:
  - `bridges/pi-bridge/src/models.test.ts` § "ChatGPT login fallback" (fake
    runtime): an `openai` ChatGPT catalogue starting `gpt-4, gpt-5.5` opens
    on `openai/gpt-6.1-sol` from `hydrateComposer` and `resolveModel`, with
    no preference and with a signed-out one. It takes the next newest when
    the newest is missing. An explicit selection and a saved default (even
    the refused `openai/gpt-5.5`) win. An API key keeps `openai/gpt-4`.
    Another provider first is kept. A catalogue with none of the backend's
    ids, and a runtime whose `isUsingSubscription` throws, keep the first
    model. So do `getModels` throwing or returning a non-array, and composer
    hydration losing its runtime after caching the catalogue. The legacy-login
    fake now supplies subscription detection and a separate backend catalogue,
    and checks the ChatGPT fallback rather than missing-method degradation.
    A provider no ChatGPT login uses gets no candidates.
  - Same file, § "ChatGPT login fallback against the pinned SDK": a real
    1.4.0 `ModelRuntime` over a temporary `auth.json` (fake tokens that never
    expire, no network). An `openai` OAuth login's catalogue starts on
    `openai/gpt-4` (the premise) and opens on `openai/gpt-6.1-sol`, from both
    `hydrateComposer` and `resolveModel`. Every backend id is in the `openai`
    catalogue that login lists. A legacy `openai-codex` login opens on
    `openai-codex/gpt-6.1-sol`. An `openai` API key keeps `openai/gpt-4`.
  - `bridges/pi-bridge/src/agent-session-default-model.test.ts`
    "constructs a ChatGPT login's session with no saved default on a model it
    runs": a real SDK session built by `ensureSession` attaches on
    `openai/gpt-6.1-sol` and carries it to `dispatchPrompt`.
  - Mutation check: making `lastResortModelId` return the first model fails
    four of the new tests (both fake-runtime selection tests and both real
    SDK ChatGPT tests).
  - Live, 2026-10-26, this host's legacy `openai-codex` ChatGPT login, in a
    temporary `HOME` and `PI_CODING_AGENT_DIR` holding a copy of that one
    credential with its refresh token replaced (so nothing could rotate the
    host's token; the access token had 22 h left). The host's `auth.json`
    and `settings.json` hashes matched before and after every run.
    - The pinned `pi` (`bun …/pi-coding-agent/dist/cli.js -p --mode json
      --no-session`) with no `--model` and no saved default answered "OK" on
      `openai-codex/gpt-6.1-sol`. `--model openai-codex/gpt-5.6-luna` and
      `--model openai-codex/gpt-6-sol` answered "OK".
      `--model openai-codex/gpt-5.5` failed with `Codex error: The 'gpt-5.5'
      model is not supported when using Codex with a ChatGPT account.`
    - The bridge's own code in process (`createSession`, `ensureSession`,
      `dispatchPrompt` from `bridges/pi-bridge/src`) on the same temporary
      directory with no saved default: the catalogue's first model was
      `openai-codex/gpt-5.6-luna`, the composer and the attached session
      chose `openai-codex/gpt-6.1-sol`, and the turn ended idle with the
      answer "OK" from `openai-codex/gpt-6.1-sol`.
- Workarounds, still valid: pick a model in the tab's picker, or save one with
  `/model` in `pi`, which the bridge then honours.

## Outstanding work

### Code

1. ~~**Start a ChatGPT-backed Pi login on a model it runs** when no default
   is saved.~~ Done 2026-10-26: neither (a), (b) nor (c) as listed, but a
   fourth option, (d), using Pi's own ChatGPT-backend catalogue. See Current
   state and decision 1.

### Qualification

- **Repeatable bridge-level live check added (2026-10-26).**
  `bridges/pi-bridge/src/agent-session-chatgpt-live.test.ts` keeps the runtime,
  SDK session and provider prompt real. It verifies no default preferences,
  `openai/gpt-4` first in the catalogue, selection and attachment on
  `openai/gpt-6.1-sol`, and a successful first provider answer. See the
  [opt-in command](../../development/testing-guide.md#opt-in-pi-chatgpt-default-model-check).
  The attempted run on this host stopped at credential preflight: its auth
  file still has only legacy `openai-codex` OAuth and an `opencode-go` API
  key. No provider prompt ran. Current-`openai` live qualification remains
  unverified until that credential is available; no host settings or credentials
  were changed.
- **A fresh agent-test profile whose host has a ChatGPT `openai` login and no
  saved default should answer its first Pi prompt with no model override.**
  Still open. This host's Pi login on 2026-10-26 is the legacy
  `openai-codex` (plus an `opencode-go` API key), not an `openai` ChatGPT
  login, and its `settings.json` saves `openai-codex/gpt-5.5`, so an
  agent-test profile here would start on that saved default (carried as
  `PI_BRIDGE_DEFAULT_MODEL`), not on the fallback. The user's `~/.pi` must not
  be changed for a test. The `openai` login uses a different OAuth client and
  token scope from the legacy one, so the legacy token cannot stand in for
  it. To close this:
  1. In a disposable directory, run the pinned `pi` with
     `HOME=<tmp> PI_CODING_AGENT_DIR=<tmp>/agent` and `/login` → OpenAI →
     "Sign in with ChatGPT". Save no default.
  2. From `bridges/pi-bridge`, with the same `HOME` and
     `PI_CODING_AGENT_DIR`, `PI_AGENT_DIR=<tmp>/agent`,
     `PI_SESSION_DIR=<tmp>/sessions` and no `PI_BRIDGE_DEFAULT_MODEL`, run a
     script that calls `createSession`, `ensureSession` and `dispatchPrompt`
     (the 2026-10-26 legacy check above). Expect the catalogue's first model
     `openai/gpt-4`, a selected and attached `openai/gpt-6.1-sol`, and an
     answer.
  3. For the agent-test path itself, on a host whose own `~/.pi` already has
     an `openai` ChatGPT login and no saved default, run
     `mise run test:agent:coordinator --credential-source pi` (rebuild the
     bridges first; see
     [agent-testing.md](../../development/agent-testing.md#bridge-builds)) and
     record that the Pi session files show `openai/gpt-6.1-sol`. If no such
     host exists, the bridge-level run in step 2 is the closest evidence;
     record it and close this item with that caveat.

## Constraints and rationale

- An explicit selection and a saved default must keep winning. This is only
  about the last fallback.
- Never write the user's `~/.pi` settings to choose a model for them.

## Assumptions and decisions

1. **Use Pi's ChatGPT-backend catalogue for a ChatGPT login's last resort.**
   - Options: (a) wait for Pi upstream to export `defaultModelPerProvider` or
     `findInitialModel`, or to filter a subscription login's catalogue;
     (b) after a turn fails with "not supported when using Codex with a
     ChatGPT account", steer the picker away from that model; (c) keep a
     bridge-side preferred model per subscription provider; (d) when the
     first model belongs to a ChatGPT subscription login, start on the newest
     model of the `openai-codex` provider's built-in catalogue that the login
     offers.
   - Choice: (d).
   - Why: (a) does not fix the case at all. Pi 1.4.0's own table names
     `openai/gpt-5.5` for this login, which the backend refuses, and the
     table is still not exported. (b) still fails the first prompt, the error
     arrives only as provider text (no structured code), and it needs a
     second turn. (c) drifts from Pi on every release, which is why 0054
     rejected it. pi-ai's `openai-codex` catalogue is the one list Pi ships of
     models the ChatGPT backend serves, and the generator refreshes it each
     release, so (d) follows Pi's data without copying any model id.
   - Pros: the first prompt runs on a fresh ChatGPT login. No model id is
     hard-coded in the bridge, only two provider ids. Nothing changes for an
     API key, for other providers, or when anything names a model. The
     pinned-SDK tests fail on a bump that breaks the premise.
   - Cons: it relies on the legacy provider's catalogue staying in pi-ai and
     staying a subset of the `openai` one. If pi-ai drops `openai-codex`, the
     fallback quietly reverts to the first model (the SDK test then fails).
     The two provider ids are hard-coded.
2. **"Newest" is the last id in the backend catalogue.**
   - Options: (a) reverse catalogue order; (b) Pi's own
     `defaultModelPerProvider["openai-codex"]`, imported from the SDK's
     internal `dist/core/model-resolver.js` by file URL, which the exports map
     otherwise blocks; (c) a heuristic such as the largest context window.
   - Choice: (a).
   - Why: pi-ai sorts the catalogue by id, so the newest version family sorts
     last, and on 1.4.0 the result equals Pi's own pick for the legacy login
     (`gpt-6.1-sol`), which ran live on both logins. (b) depends on a private
     file path. (c) has no basis in Pi.
   - Pros: no private import; one rule for both login kinds.
   - Cons: within a family, alphabetical order picks a tier by name
     (`gpt-5.6-terra` over `gpt-5.6-sol`) and a suffixed variant
     (`-mini`) would sort after its base. The upgrade runbook now asks for a
     recheck of the pick on every Pi bump.
3. **Only when the catalogue's first model is the ChatGPT login's.** If
   another provider's model comes first, that model is kept. It is what the
   bridge chose before, and nothing says that provider refuses it. This keeps
   the change to the one failing case; the cost is that a user signed in to
   two providers may not start on the ChatGPT model, which is fine.
4. **A refused saved default is not overridden.** The constraint says a saved
   default keeps winning, and Pi's `pi` starts on it too. This host's own
   saved default (`openai-codex/gpt-5.5`) is refused live, and it was not
   changed; the user can fix it with `/model`. Filtering refused models out
   of the picker was also rejected: an explicit selection must keep working,
   and the only list of accepted models is the one used here.
5. **Unknown login state degrades to the old behaviour.** A runtime that
   cannot answer `isUsingSubscription` or `getModels` (test fakes, or a
   future SDK change) leaves the first model rather than throwing on the
   request path.
6. **Live checks used a copy of the legacy credential with its refresh token
   replaced,** in a temporary `HOME`. A refresh in a copy would rotate the
   host's refresh token and sign the host's `pi` out; with the token replaced
   a refresh could only fail. Only the access token was used (22 h left), and
   the host files' hashes were checked unchanged after each run.
7. **The terminal `pi` question is answered from code for `openai`, live for
   the legacy login.** See Needs verification.

## Open questions

- None. Which of (a)–(c) was chosen: none; (d), decision 1.

## Needs verification

- Whether `pi` in a terminal, on the same fresh login, also starts on
  `gpt-5.5` and fails the same way. Partly answered 2026-10-26; the `openai`
  half still needs the qualification run's login:
  - For an `openai` ChatGPT login: yes by code. `findInitialModel` step 3
    walks `defaultModelPerProvider` in key order, reaches `openai: "gpt-5.5"`
    before `openai-codex`, finds it in the catalogue, and starts there. The
    backend refused `openai/gpt-5.5` live on 2026-10-23 (0054 run 2). Not
    run in a terminal: no `openai` ChatGPT login on this host. The
    qualification run above can confirm it in passing (`pi -p` with no
    `--model` in the same disposable directory).
  - For a legacy `openai-codex` login: no. Live on 2026-10-26, `pi` with no
    default started on `openai-codex/gpt-6.1-sol` and answered.

## Related

- [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md)
- [0172-multi-review-defaults-ignore-pi-saved-model.md](../coordinator-and-multi-review/0172-multi-review-defaults-ignore-pi-saved-model.md)
  (a Multi Review row resolves an unset Pi model to the catalogue's first
  model in the backend, before the bridge's fallback can apply)
- [credentials-and-models.md](../../development/credentials-and-models.md) § Pi, Default model
- [upgrade-agents.md](../../development/upgrade-agents.md) § Pi, step 6

## Replaces

- The open question in 0054 ("Should Pi's own fallback be treated as a
  product issue too?").
