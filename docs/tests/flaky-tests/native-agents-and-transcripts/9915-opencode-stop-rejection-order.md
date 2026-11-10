# OpenCode stop rejection ordering

- **ID:** 9915
- **Status:** open
- **Date observed:** 2026-11-10
- **Base commit:** c6de4733c5beb87a578f82a8548725305e1ff254, branch message-rewind-branch-4184f9baedf4-r1.
- **Test:** OpenCode2InteractionAdapter > stopping the turn rejects every parked request.
- **File:** apps/backend/src/core/opencode2/interactions.test.ts:307.
- **Original command:** mise run test (preparation at 0f63ce37f757f743bcece5343a3a403bebde9401).
- **Worker configuration:** concurrent default suite; backend test:workspace segment.
- **Failure:** the expected permission/form rejection array arrived in form/permission order. Both requests were rejected. Test duration 11.44 ms. Reported summary segments: 36836 pass, 4 fail, 159 not run.
- **Evidence:** .orkestrator/review-artifacts/review-validation-5ab40ec7-4bb2-4f00-aaaf-a80b48b56fef/validation-04.stdout.txt lines 3370–3401.
- **Isolated rerun:** mise run test:logged -- --name fix-opencode-owner -- bun test --cwd apps/backend ./src/core/opencode2/interactions.test.ts --parallel=1 --only-failures passed (2.7 s).
- **Hypothesis:** response arrival order may depend on concurrent transport scheduling. No root cause established or assertion changed. The branch changes the imported provider contract only by adding a type import and an optional method; no OpenCode execution code changes.
- **Disposition:** retain for verifier; preparation triage marks it related through imports-changed-file. The isolated pass does not prove an aggregate fix.
