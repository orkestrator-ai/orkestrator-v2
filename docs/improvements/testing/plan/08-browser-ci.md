# 08 — Run browser checks in pull requests

Status: Not started. Depends on: 05–07. Finding: T1.

[Plan index](00-index.md) · [Previous](07-real-workflow-browser-tests.md) ·
[Next](09-platform-qualification.md)

## Outcome

Run the existing component suite and a deterministic isolated-stack smoke suite
automatically for pull requests. Give them stable check names and explicit scope
without adding heavy fixture work to the default local aggregate command.

## Owners

- `.github/workflows/lint.yml`, or a dedicated browser workflow with stable jobs.
- `mise.toml` existing browser tasks; no replacement task runner.
- `e2e/playwright.config.ts` and agent-browser config/test matching.
- `apps/desktop/scripts/dev/lifecycle.ts` and profile status/stop/reset helpers.
- `scripts/` for a proposed bounded CI profile supervisor if needed.
- `docs/development/testing-guide.md` and `agent-testing.md`.

## Job A — component browsers

- [ ] Check out the tested revision, select the pinned mise/Bun runtime, and
      install frozen dependencies using the repository workflow pattern.
- [ ] Install the matching Playwright browser/runtime dependencies using the
      installed version's documented CLI. Verify syntax with current official
      documentation at implementation time.
- [ ] Run the existing component-browser task through `test:logged`.
- [ ] Preserve desktop and narrow viewport projects. Use an explicit worker
      count appropriate to runner capacity and separate artifact locations.
- [ ] Keep implicit server reuse disabled per step 05. A fixture-start failure
      is visible and cannot be replaced by whatever HTTP server answers.
- [ ] Upload summaries/sanitized failure evidence using step 06's policy.

## Job B — isolated-stack smoke

Use a Linux runner with a virtual display if the existing Electron-backed
launcher requires one. Browser automation drives the gateway; the job is not
native-window qualification merely because Electron hosts the profile.

- [ ] Assign a unique profile and run ID derived from job/run/attempt identity,
      validated against the existing profile naming rules.
- [ ] Pass `--no-agent-credentials` explicitly. `dev:test` normally defaults to
      provider credential sources; CI must not rely on a fresh runner having
      nothing to copy.
- [ ] Select only the toolchains required by the deterministic fixture. The
      current platform parser defaults an empty selection to all platforms;
      do not assume an empty list disables provisioning. Add a narrowly scoped
      credential-free fixture mode only if the current launcher cannot avoid
      unnecessary provider startup through existing options.
- [ ] Start the profile under an owned supervisor, with bounded startup output
      and an absolute readiness deadline. Preserve the launcher process identity.
- [ ] Poll authoritative profile status and use the returned browser URL.
      Do not hardcode discovered gateway/Vite ports or read the auth token into
      workflow logs or shell arguments.
- [ ] Run the real browser baseline and step-07 workflow recovery scenarios.
      Keep Docker and live-review opt-ins disabled in this job.
- [ ] Assert the expected scenario inventory was executed. “Zero tests” or a
      suite consisting entirely of skipped scenarios must not satisfy the job.
- [ ] Finalize/sanitize artifacts, then stop/reset the exact profile in cleanup
      even when readiness or tests fail. Add an independent final cleanup step
      for interrupted supervisor paths.
- [ ] Verify no profile-owned worker/process survives. Do not terminate other
      jobs or user processes by executable name.

## Workflow structure

Begin by running both jobs on every PR, avoiding path filters that silently
miss shared dependencies or leave required checks pending. Measure cost first.
If later narrowing is necessary, use a stable always-reporting gate that records
why a lane did not apply and includes shared protocol/config/lockfile changes.

Use read-only repository permissions and ordinary unprivileged PR execution.
Do not use privileged target-context execution for untrusted PR code. Action
references follow the existing pinned-commit policy.

Suggested initial job timeout is 20 minutes for components and 30 minutes for
isolated-stack startup plus smoke, with shorter inner startup/test watchdogs.
These are ceilings to validate on cold runners, not expected durations. Upload
and cleanup need time before the job's outer timeout expires.

## Validation of the CI itself

Exercise passing, component assertion failure, backend startup failure, workflow
hydration failure, port conflict, and cancellation. Each case must:

- Preserve its real result and executed/skipped scope.
- Produce bounded useful evidence or an explicit collection limitation.
- Drain exact-owned processes and leave no reusable profile state.
- Avoid provider credentials and production image/profile paths.

Test both a clean install and a cache-restored run if dependency/browser caching
is introduced. Cache immutable downloads/build prerequisites only; never reuse
a previous test result as this job's outcome.

## Acceptance and enforcement

Acceptance requires actual CI-run evidence, not just local Playwright success.
Record cold/warm durations, peak resource observations, and pass/failure counts
for the initial representative runs. Fix reproducible harness failures before
making a job a merge requirement; do not add automatic retries to hide them.

Stable jobs are ready for a human maintainer to add to branch protection.
Required-check administration is an external follow-up, not something this
implementation changes automatically. Existing format/typecheck/unit jobs remain
independent so one failure does not hide another lane's result.
