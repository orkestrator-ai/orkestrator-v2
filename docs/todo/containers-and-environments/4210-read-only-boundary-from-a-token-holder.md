# A bridge token holder can still clear a session's read-only boundary

## Task analysis

Analysed 2026-11-03 against `main` at `4d9ff8690`. Decided on 2026-11-04 from `main` at `e198fd4a7` (security report S2).

### Tasks

1. **Decide whether `readOnly` follows the narrow-only rule**: a request can turn a live session's read-only boundary off, which the execution-policy check does not cover. Status: done (2026-11-04): `readOnly` stays as it is, and the agent no longer holds the token; see Assumptions and decisions.

### 1. Decide whether `readOnly` follows the narrow-only rule

**Problem.** [To-do 3930](3930-bridge-credential-out-of-agent-uid.md) task 2 made every route that takes a policy narrow-only, but `readOnly` is a separate request field. An agent that reads its bridge token can send `readOnly: false` for a session the backend made read-only, and the session then runs under its ordinary policy instead of the review boundary.

**Context.** The backend moves a conversation across this boundary on purpose: a reusable Fix session runs a read-only consolidation turn and then returns to build mode, so `readOnly` is per-turn intent rather than a fixed property of the session. It is not an axis of `executionPolicyWidenings`. A coordinator process is not affected, because its policy is process authority and does not depend on this field.

**Investigation.** Read while tracing to-do 3930 task 2, not exercised as an attack. Pi `POST /session/create` calls `setSessionReadOnly` with the body's value, and its prompt route takes `readOnly` too (`bridges/pi-bridge/src/http.test.ts`, "validates readOnly and rebuilds the SDK session across policy transitions"). Cursor and ACP `POST /session/create` move an existing session the same way. Codex and Claude take `readOnly` on the prompt route. Whether each of those two applies it per turn only, and what a turn without the field does afterwards, has not been traced.

**Decisions.**

- **How should a read-only session be protected from a token holder?**
  - **Move the credential first and keep `readOnly` as it is (recommended).** To-do 3930 task 1 removes the token from the agent's reach.
    - Pros: covers this and every other token-holder route at once; no change to the backend's per-turn use of the field.
    - Cons: the boundary stays clearable until task 1 lands, and task 1 still needs a design decision.
  - **Refuse `readOnly: false` from a request while a session is read-only, and add a backend-only way to clear it.**
    - Pros: independent of task 1.
    - Cons: the backend-only path has the same credential problem as the token, and the Fix-session flow has to change.
  - **Bind read-only to the session at creation.**
    - Pros: simple rule, no per-turn state.
    - Cons: breaks reusing one conversation across review and fix turns, which the pipeline relies on.

## Assumptions and decisions

### Whether `readOnly` follows the narrow-only rule (task 1)

Took the recommended option: the rule stays as it is and the credential moved ([3930](3930-bridge-credential-out-of-agent-uid.md) task 1), so the field is a request only the backend can make. The re-check of 2026-11-04 found the investigation above still holds: Pi's prompt and create routes apply the body's value (`bridges/pi-bridge/src/http.ts`), and the Fix-session flow still moves a conversation across the boundary per turn, which is why the alternatives still cost what they say. `apps/backend/tests/bridge-credential-docker.test.ts` covers the credential on all five real bridges, and `bridges/acp-bridge/src/acp-approval-verifier.test.ts` that a request carrying `readOnly: false` is refused without the token. What the agent's uid can still do to catch a token, and so clear the boundary, is [4980](4980-agent-uid-process-control.md).

## Related

- [`3930-bridge-credential-out-of-agent-uid.md`](3930-bridge-credential-out-of-agent-uid.md)
- `docs/reports/2-26-10-27-security.md`, H4.
