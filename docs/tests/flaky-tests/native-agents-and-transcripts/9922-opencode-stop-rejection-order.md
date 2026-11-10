# OpenCode stop rejection ordering

- **ID:** 9922
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Base commit:** c6de4733c5beb87a578f82a8548725305e1ff254, branch message-rewind-branch-4184f9baedf4-r1.
- **Test:** OpenCode2InteractionAdapter > stopping the turn rejects every parked request.
- **File:** apps/backend/src/core/opencode2/interactions.test.ts:307.
- **Original command:** mise run test (preparation at 0f63ce37f757f743bcece5343a3a403bebde9401).
- **Worker configuration:** concurrent default suite; backend test:workspace segment.
- **Failure:** the expected permission/form rejection array arrived in form/permission order. Both requests were rejected. Test duration 11.44 ms. Reported summary segments: 36836 pass, 4 fail, 159 not run.
- **Evidence:** .orkestrator/review-artifacts/review-validation-5ab40ec7-4bb2-4f00-aaaf-a80b48b56fef/validation-04.stdout.txt lines 3370–3401.
- **Isolated rerun:** mise run test:logged -- --name fix-opencode-owner -- bun test --cwd apps/backend ./src/core/opencode2/interactions.test.ts --parallel=1 --only-failures passed (2.7 s).
- **Hypothesis (original):** response arrival order may depend on concurrent transport scheduling.
- **Reproduction (2026-11-10):** `bun test ./src/core/opencode2/interactions.test.ts ./src/core/opencode2/provider.test.ts --rerun-each 300 -t "rejects every parked request|denies parked permissions"` from `apps/backend` failed 4 of 600 runs at cb45798d5: two in this test and two in the sibling `OpenCode2Provider > abort interrupts and denies parked permissions and questions` (`apps/backend/src/core/opencode2/provider.test.ts:192`), each with the two replies swapped.
- **Root cause:** a test bug, not a product race. `OpenCode2Provider.rejectPendingRequests` (`apps/backend/src/core/opencode2/provider.ts`) sends every permission and form rejection concurrently through `Promise.all`, and the fake server records replies in arrival order, so either order is correct. Both tests asserted a fixed permission-then-form order. The contract (AGENTS.md invariant 10) is that every parked request is denied, not the order the denials arrive in. The branch's provider-contract change is unrelated.
- **Fix:** both tests now require exactly two replies and that the permission rejection and form rejection are each among them (`toHaveLength(2)` plus `expect.arrayContaining`), which still fails if either request is not rejected or is rejected twice. Product code is unchanged.
- **Verification:** the same 300-rerun stress passed 600 of 600 after the fix; `mise run test:logged -- --name opencode-owners -- bun test --cwd apps/backend ./src/core/opencode2/interactions.test.ts ./src/core/opencode2/provider.test.ts --parallel=2 --only-failures` passed.
- **Disposition:** resolved.
