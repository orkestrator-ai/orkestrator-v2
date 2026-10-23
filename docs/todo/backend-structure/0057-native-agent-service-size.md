# Native agent service size

Opened 2026-10-23 from
[0010-native-agent-service-collaborators.md](0010-native-agent-service-collaborators.md)
(decision 11), which removed the six-layer `extends` chain but left two files
well over the repository's 2,000-line guideline.

## Current state

- `apps/backend/src/core/native-agent-service.ts` is 3,880 lines. Its state
  now lives in collaborators; what remains is session work with little state
  of its own:
  - trusted session input, `ensureSession` / `adoptSession` /
    `inspectSession`, bridge start and peek (about 900 lines);
  - the dispatch path: `dispatchIntent`, `attemptDispatch`,
    `dispatchAdmittedPrompt` (which holds the storage lease across provider
    I/O), the parked-dispatch settles, retry and discard (about 900 lines);
  - session controls: Stop, resume, fork, session and MCP actions, steer,
    controls, interactions, sign-in (about 1,000 lines);
  - mail injection and turn outcomes, including `turnOutcomeAttempts`
    (about 600 lines);
  - provider teardown, moves and MCP evidence (about 400 lines).
- `apps/backend/src/core/native-agent-transcript-projection.ts` is 5,303 lines:
  module helpers (about 450 lines), the legacy full projection with sync and
  history (`refreshProjectionOnce` alone is about 600), the progressive
  transcript/state/discovery reads, tool details and display tails.
- Both are covered end to end by the `native-agent-service-*.test.ts` suites
  and directly by `native-agent-transcript-projection.test.ts`.

## Outstanding work

### Code

1. Split the session-control operations (Stop, resume, fork, actions,
   controls, sign-in) out of `NativeAgentService` into a collaborator taking a
   host, as 0010 did for the stateful clusters. Keep the public methods as
   delegates.
2. Move the dispatch path and mail injection into their own collaborator only
   if it can keep `dispatchAdmittedPrompt`'s lease and fence ordering in one
   place; otherwise record why it stays.
3. Split `NativeAgentTranscriptProjection` along its two read models: the
   progressive transcript/state/discovery reads and the legacy full
   projection with sync and history, sharing the tool-detail and
   projected-message caches through one owner.
4. Move the projection module's free helpers
   (`mergeContextUsageTurns`, `attachProgressToToolRows` and the rest) into
   their own module.

### Qualification

Each split adds direct tests for the new class through its public interface,
moves any `forTesting()` reads with the state, and leaves the end-to-end
service suites unchanged as the oracle.

## Constraints and rationale

- The constraints in 0010 still apply: bounds move with their state, the
  storage lease is held across provider I/O during dispatch, close never
  deletes a provider session, background work is not tied to UI state.
- No `extends` layers: `tests/unit/inheritance-chains.test.ts` rejects them.
- This is size and readability work; nothing here changes behaviour or removes
  an ordering risk, which is why it rates low.

## Open questions

- Whether `dispatchAdmittedPrompt` and the Stop path should share one
  collaborator, since both take the session work fence and the interrupt
  fences in a fixed order.

## Related

- [0010-native-agent-service-collaborators.md](0010-native-agent-service-collaborators.md)
- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md)
- [`native-agent-service.md`](../../architecture/native-agent-service.md)

## Replaces

Nothing; new work.
