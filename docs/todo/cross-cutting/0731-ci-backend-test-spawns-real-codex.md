# Two backend schedule tests run the real Codex CLI, which calls OpenAI and logs the prompt

Checked against `main` at `863b5782` (2026-10-27). Fixed on 2026-10-28
against `main` at `1d1f0a87`; see Current state.

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

1. **Make the public-API harness hermetic for naming**: add a failing assertion first, then give the harness a stub `codex`. Status: done (2026-10-28).
2. **Keep the prompt out of the rename failure log**: log a content-free summary instead of Codex's stderr. Status: done (2026-10-28).
3. **Confirm on CI**: check that CI backend output no longer shows `api.openai.com` or the slug prompt. Status: done (2026-10-28) by the recommended focused local run; CI's own output is not inspected (see Needs verification).

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

**Investigation.** Done 2026-10-28 with the recommended evidence, a focused
local run (see Current state for the commands and counts).

**Decisions.**

- **What is the evidence?**
  - **A focused local run of `public-api-schedules.test.ts` with a signed-out `codex` on `PATH`, showing no `api.openai.com` line and the stub log assertions passing (recommended).**
    - Pros: deterministic; needs no CI failure to see output.
    - Cons: not CI itself.
  - **Wait for the next red `main` run and search its backend output.**
    - Pros: real CI evidence.
    - Cons: depends on an unrelated failure happening.

## Current state

Fixed on 2026-10-28.

- `createPublicApiHarness` writes a slug-writing stub at `<root>/bin/codex`
  (`installNamingStub` in `apps/backend/src/core/public-api/test-support.ts`).
  `resourceRoot` is the harness root, so `resolveCodexBinary` finds the stub
  before it would fall back to `codex` on `PATH`. The stub appends one line per
  call to `<root>/codex-naming.log`, and `harness.namingCalls()` returns them.
- Both schedule tests (`public-api-schedules.test.ts`, "environment launch:
  resolves the base branch's newest commit when it fires" and "public launch
  replay after admission uses its original commit after the branch advances")
  assert, through `expectOneNamingCall`, that naming ran exactly once, as
  `exec` with `--output-last-message`, with their prompt in the slug prompt.
- A failed first-prompt rename no longer passes the error to `console.warn`.
  `PendingRenameFailureLog` (`apps/backend/src/core/pending-rename-failure-log.ts`)
  logs `[ElectronBackend] Failed to rename environment from pending prompt`
  with `{ environmentId, reason, error, exitCode, signal }`, where `reason` is
  `command-timed-out`, `command-missing`, `command-failed` or `error` and
  `error` is the error's class name. Repeated failures for the same
  environment and intent are logged only as a count at the 2nd, 4th, 8th...
  failure, and once more when a retry succeeds. `commands-registry.ts` records
  the failure inside `pendingEnvironmentRenameTask`; its callers only swallow
  the rejection. `reconcilePendingEnvironmentRenames` forgets environments that
  no longer hold an intent.
- Tests: `pending-rename-failure-log.test.ts` (summary fields, once per
  intent, power-of-two counts, recovery, pruning);
  `tests/commands-environment.test.ts` "retains a failed pending rename…" now
  uses a failing stub whose stderr echoes its whole argument list, slug prompt
  included, and asserts the single warning carries neither the user prompt nor
  the slug prompt; `tests/commands-registry-environments-create.test.ts` "backs
  off failed reconciliation…" asserts the failure line and the recovery count.
- Failing first: with only the assertions added and a recording sentinel
  `codex` first on `PATH` (it never reaches the network; it prints a 401 line
  and echoes its arguments to stderr, as a signed-out Codex does), both
  schedule tests failed (8 pass, 2 fail), the sentinel was called twice, and
  the output held two `api.openai.com` lines and the prompts. A mutation that
  adds the error to the warning fails both logging tests.
- After the fix, the same focused run: 10 pass, 0 fail, no sentinel call, no
  `api.openai.com` line, no "scheduled audit", "replay audit" or "slug
  generator" text in the output.
- Other harnesses (Outstanding work, item 4): no other gap. Static search: the
  only backend test files that reach `prepare_environment_first_prompt`,
  `rename_environment_from_prompt` or a pending rename through the real
  registry either stub Codex (`isolateCodexBinaryLookup` with `withFakeCodex`
  in `commands-environment.test.ts` and
  `commands-registry-environments-create.test.ts`) or replace the command
  (`prompt-queue-drainer.test.ts`, `native-agent-service-dispatch.test.ts`,
  `index.test.ts`); the other matches only read `pendingRenamePrompt`.
  Dynamic check: the whole backend package, both tiers (781 files, 12,891
  tests), with the sentinel first on `PATH`, made no call to it.
- [testing-guide.md](../../development/testing-guide.md#agent-clis-on-path)
  documents the `PATH` fallback and which fixtures stub Codex.

## Outstanding work

### Code

1. **Done (2026-10-28):** stub-log assertions added to the two schedule
   tests; they failed before the stub (see Current state).
2. **Done (2026-10-28):** slug-writing stub at `<root>/bin/codex` in
   `createPublicApiHarness`, logging to `<root>/codex-naming.log`.
3. **Done (2026-10-28):** content-free summary, logged once per environment
   and intent, then as a count; tested with a failing stub that echoes the
   prompt.
4. **Done (2026-10-28):** other backend harnesses searched, statically and by
   a full backend run with a recording `codex` on `PATH`; no other gap.

### Qualification

- **Done (2026-10-28):** focused run of `public-api-schedules.test.ts` with a
  signed-out stand-in `codex` on `PATH`: no `api.openai.com` line and no slug
  prompt in the output (decision 4 explains the stand-in).

## Constraints and rationale

- Unit tests must not reach the network or use the developer's provider
  login.
- Logs never contain prompts (AGENTS.md invariant 12); this applies to error
  text from child processes too.
- Do not change `PATH` globally in the harness: tests run in parallel
  workers and some already change it.

## Assumptions and decisions

1. **Stub location: a slug-writing stub at `<root>/bin/codex` in
   `createPublicApiHarness` (2026-10-28).** Options: (a) the stub in the
   harness root; (b) a naming construction option on
   `CommandRegistryOptions`, faked by the harness; (c) a suite-wide fail-fast
   `codex` prepended to `PATH` in `tests/setup-node.ts`. Chose (a), as the
   analysis recommended. Pros: no product change, no process-wide `PATH`
   change, and the real `runCommand` spawn, output file and rename still run
   end to end. Cons: protects only this harness; another fixture that forgets
   still leaks (the testing guide now says so, and item 4 found none today).
   (b) adds a product seam used only by tests and skips the real spawn path;
   (c) conflicts with CI deliberately putting the pinned Codex on `PATH` and
   with tests that change `PATH` themselves.
2. **Proof: assert one `exec` call with `--output-last-message` in the stub
   log (2026-10-28).** Options: (a) the stub-log assertion; (b) assert the
   environment's final name. Chose (a), plus a check that the call's last
   argument contains the test's prompt. Pros: deterministic, fails before the
   stub exists, and proves naming ran rather than being skipped. Cons: tied to
   the naming call's argument shape. (b) needs an extra wait because the
   rename is asynchronous and the tests delete the environment. The stub
   flattens tabs and newlines in each argument so one call is one log line.
3. **Warning content and repeats (2026-10-28).** Options for content: (a) a
   content-free summary; (b) keep stderr with `redactValues` for the slug and
   user prompts. Chose (a): error class name, exit code, signal and a fixed
   `reason` derived from `timedOut` and `executableMissing`. Pros: meets
   invariant 12 by construction and still separates a timeout, a missing
   binary and a refusing Codex. Cons: Codex's own text (for example the 401
   wording) is gone, so a support case needs a manual `codex exec`. (b) fails
   open on any re-wrapped echo. The `reason` names say "command", not
   "codex", because the same path also runs Git for the branch rename, so a
   `CommandFailedError` is not always Codex's. For repeats, options were (a)
   log the first failure per environment and intent, then only a count;
   (b) log every retry. Chose (a), with the count logged at power-of-two
   failures and once on recovery, so a signed-out user gets about seven lines
   in an hour instead of 120 and the count is still visible. Cons: a small
   per-environment map in the registry closure; it is pruned on each
   reconcile pass to environments that still hold an intent. A changed
   intent, or an environment pruned while stopped, logs its first failure
   again. The recovery line uses `console.warn` like the failure lines so the
   three can be found together.
4. **Qualification evidence: a focused local run with a stand-in signed-out
   `codex` (2026-10-28).** Options: (a) a focused local run; (b) wait for a
   red `main` run and search its backend output. Chose (a), as recommended.
   The stand-in is a recording shell script first on `PATH`, not the real
   Codex binary with an empty `CODEX_HOME`: the host's `codex` is signed in
   with the user's account, and an empty `CODEX_HOME` alone does not prove
   Codex would not find a keyring login, so the real binary was not run. The
   stand-in prints a `wss://api.openai.com` 401 line and echoes its arguments,
   so any call would have shown up in the output, as it did before the fix.
   Pros: deterministic, no network, no use of the user's login. Cons: not CI
   itself, and not the real binary.
5. **The retry-policy question moved to a new file (2026-10-28).** The open
   question (fall back to a local slug sooner when Codex is not signed in) is
   a product choice outside this file's scope. It is now
   [0430-first-prompt-naming-signed-out-retries.md](0430-first-prompt-naming-signed-out-retries.md),
   so this file has nothing left.

## Open questions

- None. The retry-policy question is in
  [0430-first-prompt-naming-signed-out-retries.md](0430-first-prompt-naming-signed-out-retries.md).

## Needs verification

- Whether, before this fix, a signed-in developer `codex` on `PATH` made a
  real model call from these tests. Inferred from code, deliberately not run
  (it would use the user's account). The fix makes the question moot for this
  harness: the stub is always found before `PATH`.
- CI output itself was not inspected after the fix; passing output is deleted
  by `test:logged`, so only a later red run with this change would show the
  backend group. The local runs above are the evidence.

## Related

- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md): where this was found.
- [0430-first-prompt-naming-signed-out-retries.md](0430-first-prompt-naming-signed-out-retries.md): the retry policy for a Codex that cannot sign in.
- [testing-guide.md](../../development/testing-guide.md#agent-clis-on-path): agent CLIs on `PATH` in tests.
- [backend-runtime.md](../../architecture/backend-runtime.md): test seams as construction options.

## Replaces

Nothing; new on 2026-10-27, split from
[0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md)'s task
analysis.
