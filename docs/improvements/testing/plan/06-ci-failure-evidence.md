# 06 — Retain useful CI failure evidence

Status: Not started. Depends on: 04 for new scope fields; initial upload can
land independently. Finding: T2.

[Plan index](00-index.md) · [Previous](05-browser-fixture-ownership.md) ·
[Next](07-real-workflow-browser-tests.md)

## Outcome

A failed CI run provides the original bounded failure evidence even when the
interesting output was truncated from the console. Collection and upload must
not conceal the command's failure, leak authentication state, or require reruns.

## Owners

- `.github/workflows/lint.yml` and future browser/platform jobs.
- `scripts/test-all.ts` and `scripts/run-logged.ts`: summary/finalization.
- `tests/unit/run-logged.test.ts`, `test-all.test.ts`, and
  `test-diagnostic-bounds.test.ts`.
- `e2e/agent-testing/artifact-sanitizer.ts`, its tests, and `global-teardown.ts`.
- Playwright configs and `docs/development/test-logs.md`.

## Artifact contract

Use one private, job-specific artifact root with separate directories for each
command, profile, and attempt. Set `ORKESTRATOR_TEST_LOG_DIR` only to the command's
directory; concurrent commands must not share it.

Upload `summary.json` and bounded compressed failure logs. Successful runs need
only a compact summary unless a test explicitly produces approved evidence.
Start with seven-day CI retention, matching the local runner's policy, and
measure actual artifact volume before increasing it.

For browser jobs, publish a sanitized copy/staging directory containing the
JSON report, allowed screenshots, and sanitized failure traces. Raw captures
are not an upload source. Trace sanitization does not redact arbitrary screenshot
pixels; credential-free synthetic fixtures are the primary protection.

## Implementation tasks

- [ ] Configure the existing unit/integration CI job with a unique artifact
      directory and an upload step that runs after test failure.
- [ ] Preserve the exact test exit status. Artifact collection is a subsequent
      operation, not a shell pipeline whose last exit code masks the test.
- [ ] Upload compact summaries after success as well, including step 04 scope
      data once available. Give artifacts deterministic job/suite/attempt names.
- [ ] Handle absence of artifacts after startup failure explicitly. Distinguish
      “test never started,” “capture failed,” and “upload failed.” None is a pass.
- [ ] Verify upload behavior after job cancellation separately from normal
      failure. Forced runner termination cannot guarantee finalization; report
      that limit and collect finalized partial evidence when available.
- [ ] Add a bounded manifest of artifact names, sizes, completion state, and
      sanitization outcome. Do not include command contents or credentials in
      workflow summary annotations.
- [ ] Make sanitization idempotent and usable by an outer CI finalizer when
      Playwright teardown did not run. Require positive sanitization completion
      before any browser evidence is uploaded.
- [ ] Audit teardown's invocation of profile discovery against the current
      mise command surface. The current `global-teardown.ts` still constructs
      a root package-script invocation for status; route it through the supported
      task or the existing profile helper so exact-secret redaction is reliable.
- [ ] Collect/sanitize profile-dependent evidence before deleting profile state;
      then stop/reset the exact profile even if collection failed. Structure
      cleanup so an artifact error cannot leave the app running.
- [ ] Share collection policy across browser and Electron jobs. The Electron
      config currently needs its own explicit audit for teardown/sanitization.
- [ ] Use the repository's pinned-action convention and current official action
      documentation when authoring workflow syntax. Do not introduce broad
      repository permissions or secrets into untrusted PR execution.

## Failure experiments

| Experiment | Expected result |
| --- | --- |
| Failure occurs before a long output tail | Full retained bounded log includes original failure |
| Output exceeds existing limit | Process is stopped, overflow recorded, evidence remains bounded |
| Log compression/write fails | Artifact error recorded; original test status remains visible |
| Test passes | Summary retained; unnecessary raw log not published |
| Browser test fails | Report, allowed screenshot, and sanitized trace available |
| Sanitizer fails or input exceeds its limit | Raw evidence withheld; manifest explains incomplete evidence |
| Playwright process dies before teardown | Outer finalizer attempts bounded sanitization and cleanup |
| Credential sentinel appears in text/cookie/trace | Sentinel absent from upload staging tree |
| Two concurrent jobs | No directory or artifact-name collision |

Use synthetic secret sentinels only. Do not fetch real credentials to test
redaction. Test compressed archives, nested files, malformed report data, and
oversized artifacts using the existing sanitizer suite.

## Verification and acceptance

Run logged runner/diagnostic/sanitizer tests. Exercise a temporary intentionally
failing CI branch or workflow dispatch, download the resulting artifact, and
verify its contents and byte bounds. Remove intentional failures before handoff.
Do not call the step complete based solely on workflow YAML inspection.

Acceptance: a reviewer can diagnose the original failure without rerunning;
artifact status is distinct from test status; uploaded evidence contains no
synthetic auth sentinel; cleanup succeeds on both pass and failure paths.

## Rollout

Land existing test-job uploads first, then reuse that policy in steps 08 and 09.
An upload outage must not convert a failing test to success. If artifact volume
exceeds the proposed budget, preserve useful failure slices and report omitted
evidence explicitly rather than raising every limit.
