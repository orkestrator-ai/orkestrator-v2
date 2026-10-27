# Two backend schedule tests run the real Codex CLI, which calls OpenAI and logs the prompt

Checked against `main` at `863b5782` (2026-10-27).

Two tests in `apps/backend/src/core/public-api/public-api-schedules.test.ts`
launch an environment with a first prompt. That queues the first-prompt
rename, which runs the real `codex exec` to generate a slug. On CI the pinned
Codex is on `PATH` with no login, so it calls `wss://api.openai.com` and
`https://api.openai.com`, gets 401 several times and fails. The tests still
pass, but the unit suite makes outbound network calls. On a developer machine
with a signed-in `codex` on `PATH` it probably makes a real, billed model call.
The same code path also writes the user's prompt to the backend log whenever
naming fails, in production too. Found in the task analysis of
[0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md#1-apply-the-required-check-ruleset).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Make the public-API harness hermetic for naming**: add a failing assertion first, then give the harness a stub `codex`. Status: open.
2. **Keep the prompt out of the rename failure log**: log a content-free summary instead of Codex's stderr. Status: open.
3. **Confirm on CI**: check that CI backend output no longer shows `api.openai.com` or the slug prompt. Status: open (depends on 1 and 2).

### 1. Make the public-API harness hermetic for naming

**Problem.** The public-API test harness does not stub the environment-naming command, so any harness test that launches an environment with a prompt runs whichever `codex` is on `PATH`.

**Context.** CI's "Download pinned parser binaries" step puts the pinned Codex on `PATH` (`.github/workflows/ci.yml:91-96`). Other backend fixtures already stub it: `codexSlugScript` and `withFakeCodex` in `apps/backend/tests/command-fixtures.ts:1048` and `:1361`. The public-API harness does not.

**Investigation.** Confirmed from code and from CI.
- `createPublicApiHarness` (`apps/backend/src/core/public-api/test-support.ts:56-80`) sets `appRoot` and `resourceRoot` to a temporary root, with no `toolchainBinDir` and no `runtimeFlavor`.
- `resolveCodexBinary` (`apps/backend/src/core/commands-agent-support.ts:375`) looks for a managed copy (`managedBinaryCandidates`, `:329-336`: `<toolchainBinDir>/codex`, `<resourceRoot>/bin/codex`, `<appRoot>/binaries/codex`, `<appRoot>/bin/codex`). If none exists it returns the bare name `codex` (`:360-373`), so `PATH` decides.
- The path is `prepareEnvironmentFirstPrompt` (`apps/backend/src/core/commands-registry.ts:213-247`), then `pendingEnvironmentRenameTask` (`:156-197`), then `renameEnvironmentFromPrompt` (`commands-agent-support.ts:937-947`), then `generateEnvironmentNameWithCodexExec` (`:683-722`), which spawns `codex ... exec ... <slug prompt>` at `:692`.
- The two tests are "environment launch: resolves the base branch's newest commit when it fires" (`public-api-schedules.test.ts:203`, prompt "scheduled audit" at `:223`) and "public launch replay after admission uses its original commit after the branch advances" (`:512`, prompt "replay audit" at `:534`).
- The CI log confirms both: run 40379705332, job 121772316895 ("Unit and integration tests", 2026-10-26). Under `::group::src/core/public-api/public-api-schedules.test.ts:` there are two `[ElectronBackend] Failed to rename environment from pending prompt: CommandFailedError` warnings. Each shows Codex v0.164.0 (`model: gpt-5.6-luna`, `workdir: /tmp`) retrying `wss://api.openai.com/v1/responses` (401), falling back to HTTPS, and failing with "401 Unauthorized: Missing bearer or basic authentication in header". The stack is `generateEnvironmentNameWithCodexExec (commands-agent-support.ts:692)` ← `renameEnvironmentFromPrompt (:947)` ← `commands-registry.ts:176`. Each run took at least seven seconds of retries (19:01:14 to 19:01:21 and 19:01:28 to 19:01:34). These were the only two rename failures in that log. Passing output is deleted by `test:logged`, so green runs cannot be checked the same way.
- The 0030 analysis cited `commands-agent-support.ts:109`. That line is inside the slug prompt text (`buildSlugGenerationPrompt`); the spawn is at `:692`.
- The developer-machine case was not run (it would make a live call). `tests/setup-node.ts` does not isolate `CODEX_HOME`, and `--ignore-user-config` ignores configuration, not the login, so a signed-in `codex` on `PATH` would use the developer's account.

**Decisions.**

- **Where should the stub go?**
  - **Have `createPublicApiHarness` write a slug-writing stub at `<root>/bin/codex` (recommended).** `resourceRoot` is already `root`, so `resolveManagedBinary` picks it up with no product change. Reuse the shape of `codexSlugScript` and log each call to a file in the harness root.
    - Pros: per context, no process-wide `PATH` change; the real `runCommand` path and rename still run end to end; a few lines in one file.
    - Cons: it protects only this harness; another harness that forgets still leaks.
  - **Add a naming construction option to `CommandRegistryOptions` (like `FeatureBuildContext.generateEnvironmentName`, `apps/backend/src/core/feature-build.ts:42`) and default it to a fake in the harness.**
    - Pros: no shell script; follows the "test seams are construction options" rule in `backend-runtime.md`.
    - Cons: a product change made only for tests; the real spawn and output-file path go untested in these suites.
  - **A suite-wide fail-fast `codex` shim prepended to `PATH` in `tests/setup-node.ts`.**
    - Pros: catches every harness, including future ones.
    - Cons: CI deliberately puts the pinned Codex on `PATH`, so tests that need the real binary would need an opt-out; `PATH` is process-global and some tests already change it.
- **How is the fix proved?**
  - **Assert in both tests that the stub log recorded exactly one `exec` call with `--output-last-message` (recommended).** Written first, this fails today because no stub exists.
    - Pros: a deterministic failing-then-passing test; it also proves the rename ran rather than being skipped.
    - Cons: ties the tests to the naming call's argument shape.
  - **Assert only that the environment ends with the stub's slug as its name.**
    - Pros: tests the outcome, not the arguments.
    - Cons: the tests delete the environment at the end, and the rename is asynchronous, so the assertion needs an extra wait.

### 2. Keep the prompt out of the rename failure log

**Problem.** When naming fails, the backend logs Codex's stderr, which repeats the slug prompt and with it up to 200 characters of the user's first prompt. AGENTS.md invariant 12 says logs never contain prompts.

**Context.** Production logging tees the backend's console into the app log (`~/.config/orkestrator-v2/logs/orkestrator-ai-<date>.log`, see `docs/debugging/process-crashes-and-kills.md`). Feature-build naming already logs a content-free discriminator (`feature-build.ts:111` and `:151-152`).

**Investigation.** Confirmed from code and from the CI log, where the slug prompt with "scheduled audit" and "replay audit" appears in full.
- `runCommandBytes` builds `CommandFailedError` from stderr (`apps/backend/src/core/shell.ts:326-331`). Only `redactValues` is removed, and the naming call passes none.
- `logPendingEnvironmentRenameFailure` passes the whole error to `console.warn` (`commands-registry.ts:199-200`).
- A failed rename keeps its intent and retries after 30 seconds (`commands-registry.ts:183-187`). The `pending-renames` recurring job runs every two seconds while an environment holds an intent (`apps/backend/src/core/index.ts:1821-1830`), so a signed-out or offline Codex logs the prompt about every 30 seconds while the environment runs.
- No such line is in this host's app logs for 2026-10-25 to 2026-10-27 (counted, not read), so this is reachable but not observed here.

**Decisions.**

- **What should the warning contain?**
  - **A content-free summary: error name, exit code, `timedOut`, `executableMissing`, and a fixed reason (recommended).**
    - Pros: meets invariant 12 by construction; matches feature-build's pattern; still tells a timeout from a missing binary from a refused login.
    - Cons: loses Codex's own diagnostic text (for example the 401 wording), so a support case needs a manual `codex exec` run.
  - **Keep stderr but pass the slug prompt and the user prompt as `redactValues`.**
    - Pros: keeps Codex's diagnostics.
    - Cons: exact-match redaction misses any re-wrapped or partial echo, and Codex may print other prompt-derived text; it fails open.
- **Should repeated failures be logged every time?**
  - **Log the first failure per environment and intent, then only a count (recommended).**
    - Pros: no log line every 30 seconds for a signed-out user.
    - Cons: a little per-environment state in the registry closure.
  - **Log every retry.**
    - Pros: no extra state.
    - Cons: noisy log while an environment runs.

### 3. Confirm on CI

**Problem.** The CI evidence came from a failing run's printed output; after the fix there should be no outbound Codex call in the backend group.

**Context.** `test:logged` deletes passing output, so the check needs a run whose backend group prints, or a local run of the one file.

**Investigation.** Not started.

**Decisions.**

- **What is the evidence?**
  - **A focused local run of `public-api-schedules.test.ts` with a signed-out `codex` on `PATH`, showing no `api.openai.com` line and the stub log assertions passing (recommended).**
    - Pros: deterministic; needs no CI failure to see output.
    - Cons: not CI itself.
  - **Wait for the next red `main` run and search its backend output.**
    - Pros: real CI evidence.
    - Cons: depends on an unrelated failure happening.

## Current state

- `createPublicApiHarness` has no naming stub
  (`apps/backend/src/core/public-api/test-support.ts:56-80`), so
  `resolveCodexBinary` falls back to `codex` on `PATH`
  (`apps/backend/src/core/commands-agent-support.ts:360-375`).
- `public-api-schedules.test.ts:203` and `:512` launch environments with a
  prompt, which reaches `generateEnvironmentNameWithCodexExec`
  (`commands-agent-support.ts:683-722`, spawn at `:692`).
- CI run 40379705332 shows both tests running Codex 0.164.0 against
  `api.openai.com` and getting 401. The tests pass regardless.
- The rename failure warning logs Codex's stderr, prompt included
  (`commands-registry.ts:199-200`, `shell.ts:326-331`), and retries every 30
  seconds while the intent is pending (`commands-registry.ts:183-187`,
  `index.ts:1821-1830`).
- Other backend fixtures already stub Codex (`apps/backend/tests/command-fixtures.ts:1048`, `:1361`).

## Outstanding work

### Code

1. Add the stub-log assertions to the two schedule tests and see them fail.
2. Write a slug-writing stub `codex` at `<root>/bin/codex` in
   `createPublicApiHarness`, logging its calls to a file in the harness root.
3. Replace the payload of `logPendingEnvironmentRenameFailure` with a
   content-free summary, and log repeated failures for the same intent once.
   Add a test that a failing stub whose stderr echoes the prompt produces a
   warning without the prompt text.
4. Search the other backend harnesses that call `prepare_environment_first_prompt`
   or launch with a prompt for the same gap.

### Qualification

- Focused run of `public-api-schedules.test.ts` with a signed-out `codex` on
  `PATH`: no `api.openai.com` line and no slug prompt in the output.

## Constraints and rationale

- Unit tests must not reach the network or use the developer's provider
  login.
- Logs never contain prompts (AGENTS.md invariant 12); this applies to error
  text from child processes too.
- Do not change `PATH` globally in the harness: tests run in parallel
  workers and some already change it.

## Open questions

- Should first-prompt naming fall back to a local slug sooner when Codex is
  not signed in, as feature-build does, rather than retrying every 30
  seconds?

## Needs verification

- Whether a signed-in developer `codex` on `PATH` makes a real model call
  from these tests (inferred from code, not run).

## Related

- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md): where this was found.
- [testing-guide.md](../../development/testing-guide.md)
- [backend-runtime.md](../../architecture/backend-runtime.md): test seams as construction options.

## Replaces

Nothing; new on 2026-10-27, split from
[0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md)'s task
analysis.
