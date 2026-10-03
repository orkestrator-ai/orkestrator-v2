# 07 — Exercise persisted validation workflows in the browser

Status: Not started. Depends on: 01–03; use 06 for artifact handling. Finding: T7.

[Plan index](00-index.md) · [Previous](06-ci-failure-evidence.md) ·
[Next](08-browser-ci.md)

## Outcome

Prove that a real persisted review/build workflow displays correct validation
after its initiating component unmounts and the browser reloads. Keep the
existing direct-worker browser test as backend/gateway coverage, but add a test
that would fail if only renderer restoration broke.

## Integration boundary

Use a deterministic provider implementation to supply discovery/review results.
Keep workflow controllers, command registry, storage, gateway authentication,
real command execution, scheduler, package sealing, stores, and renderer real.

Do not construct a completed renderer snapshot or stub `status_review_validation`
in the browser; that would bypass the behavior this test must establish.
Do not call a live model simply to obtain a predictable validation plan.

## Existing owners

- `e2e/agent-testing/browser-gateway.spec.ts` and browser config.
- `apps/backend/src/core/review-validation-controllers.test.ts`: deterministic
  provider pattern, currently with mocked command invocation.
- `build-pipeline-service-base.ts` and `multi-review-service.ts`: existing
  provider injection seams.
- `apps/desktop/scripts/dev/fixture.ts`, `lifecycle.ts`, and `arguments.ts`.
- `test-fixtures/agent-project/`: isolated project copied into QA profiles.
- Real workflow stores and validation UI from step 03.

## Fixture design

- [ ] Add a bounded deterministic provider scenario through the existing
      service construction seam. Keep it restricted to an explicit agent-test
      profile with a validated fixture identity.
- [ ] Prefer a test-only backend composition entrypoint or injected factory.
      If a runtime option is necessary, reject it outside the agent-test flavor;
      never expose an arbitrary “set workflow state” production HTTP endpoint.
- [ ] Return a real HEAD from the fixture repository and a valid step-01 plan.
      Return schema-valid review results only after the real worker/package
      stages complete. Preserve request IDs and normal idempotency handling.
- [ ] Supply commands with explicit synchronization: started marker, release
      barrier, completion marker, and bounded wait. Keep markers in an exact
      fixture-owned ignored directory so they do not falsely alter source scope.
- [ ] Use barriers instead of timing assumptions such as “sleep six seconds
      should keep the blocker alive.” Every wait has a deadline and diagnostic.
- [ ] Record a bounded invocation counter outside renderer state so the test
      can detect duplicate command dispatch after reload/reconnect.
- [ ] Support success, assertion failure, missing-required-check, explicit
      infrastructure-incomplete, and cancellation scenarios. Avoid arbitrary
      shell input in fixture-control channels; expose enumerated scenarios.
- [ ] Ensure the fixture cannot call real providers, access host credentials,
      or modify projects outside its seeded profile.

## Primary browser flow

1. Start a uniquely named isolated profile with credential seeding disabled.
2. Authenticate through the existing single-use bootstrap path; verify profile
   identity and select the copied fixture project.
3. Create two local environments. Launch review/build validation through the
   normal UI when practical; backend setup helpers may create unrelated setup
   state, but the workflow lifecycle under test must remain real.
4. Hold capacity with a controlled fixture job and assert the target's visible
   queued state and reason. Release the blocker and assert running state.
5. Switch to the other environment so the initiating view can unmount.
6. Release the target command and wait for backend completion without mounting
   its validation view.
7. Return and assert visible command rows, normalized outcome, limitations,
   source qualification, and available output controls.
8. Open a command's output and assert the bounded synthetic completion marker.
9. Reload, reopen the workflow, and repeat visible assertions. Assert the
   invocation counter remains one and the run/package identity is unchanged.
10. Stop/delete fixture environments, sanitize evidence, stop/reset the profile,
    and verify no owned worker or launcher remains.

## Additional scenarios

| Scenario | Assertions |
| --- | --- |
| Empty plan with reason | Not validated visible before and after reload |
| Passed unit command, required browser omitted | Incomplete overview with named missing requirement |
| Assertion failure | Failure icon/text, real exit code, inspectable evidence |
| Infrastructure unavailable | Incomplete, not failed assertion; reason survives remount |
| Cancellation while queued | Ticket removed; no process later starts |
| Cancellation while running | Owned process drains; partial output readable |
| Backend recreation with live worker | Existing run reattached, no second command |
| Source drift | Passing process does not erase source warning |
| Manual Multi Review and build pipeline | Both surfaces consume the same assessment and persisted state |

Keep the primary flow short; split failure/cancellation scenarios into separate
tests with independently owned environments. One shared failed fixture must not
cascade through the entire suite.

## Assertions and diagnostics

Assert user-visible roles/names and summary text. API checks may support identity
and process-count assertions, but cannot replace the UI assertions. Capture
screenshots only of synthetic content. On timeout report phase, run ID, and
bounded status metadata without dumping prompts, terminal history, or tokens.

Prove sensitivity once by temporarily breaking renderer hydration while leaving
the status API healthy. The new browser regression must fail. Remove that
temporary fault before handoff and record the experiment.

## Verification and acceptance

Run provider-fixture and controller tests, then the logged agent-browser suite
against the isolated profile. Repeat the critical reload case under normal host
admission, not an artificially oversubscribed stress configuration. Also verify
the test-only provider is rejected by an ordinary production-profile startup.

Acceptance: UI restoration failures are observable, no model credentials are
needed, at-most-once execution survives reload, and cleanup succeeds after every
scenario. The direct-worker test remains useful and need not be deleted.
