# 01 — Establish contracts and deterministic regression fixtures

Status: Planned.  
Depends on: None.  
Findings: INC-01 through INC-09.  
Next: [02 — Mandatory persistence](02-mandatory-persistence-and-dispatch-barriers.md).

## Goal

Turn the review's observations into reproducible, owner-specific tests and a
small conformance matrix. The first fixes should start from demonstrated failures
without depending on live providers, production credentials, or sleep-based
races. This preparation ships with the relevant fixes; do not merge an
intentionally failing baseline suite.

## Read and map the owners

- [Cursor HTTP routes](../../../../bridges/cursor-bridge/src/http.ts),
  [persistence](../../../../bridges/cursor-bridge/src/persistence.ts), and
  [fake agent](../../../../bridges/cursor-bridge/src/testing/fake-agent.ts).
- [Pi HTTP routes](../../../../bridges/pi-bridge/src/http.ts),
  [session lifecycle](../../../../bridges/pi-bridge/src/agent-session.ts), and
  [prompt acceptance](../../../../bridges/pi-bridge/src/prompt.ts).
- [Backend provider contract](../../../../apps/backend/src/core/agent-provider-contract.ts)
  and [dispatch service](../../../../apps/backend/src/core/native-agent-service-dispatch.ts).
- [Draft tests](../../../../apps/web/src/lib/draft-persistence.test.ts) and
  [protocol capability tests](../../../../packages/protocol/src/native-agent.test.ts).
- [Testing guide](../../../development/testing-guide.md).

Check HEAD and the working diff before implementing. Revalidate the finding if
the owning code has changed since the source revision; record an already-fixed
case with its regression evidence instead of reapplying the same fix.

## Tasks

- [ ] Inventory the authoritative owners of session identity, dispatch intent,
  active run, cancel request, attach promise, close state, transcript cursor,
  and persisted draft. Note which records survive bridge versus backend restart.
- [ ] Write the expected/observed contract matrix below into test names or a
  small fixture registry. Keep native provider differences explicit.
- [ ] Reuse the existing real-router harness and fake-agent seams. Add only the
  controls needed to pause attach, SDK send, preflight, file publication, and
  disposal. Expose observable call counts and completion events.
- [ ] Use a temporary, private state directory per test. Snapshot and restore
  each environment key exactly, including absence. Point credential and vendor
  state paths at fixtures, and disable account/model refresh network calls.
- [ ] For publication races, wrap a narrow writer operation or use a controlled
  fixture process. Keep serialization, journal mutation, and route logic real.
  Avoid mocking the whole persistence or HTTP module being tested.
- [ ] For restart tests, provide two paths: read the published file in a fresh
  module/process without flushing, and kill an exact-owned fixture process
  after an explicit checkpoint. A normal shutdown test is separate.
- [ ] Extract stateless helpers only when several tests need them. Avoid a new
  universal bridge harness whose abstraction hides which provider accepted work.
- [ ] Give each new regression a focused sibling file when its existing owner
  is already large. Candidate names in later steps are proposed files, not claims
  that those files already exist.

## Required reproduction matrix

| Finding | Controlled condition | Assertion that must fail before the fix |
| --- | --- | --- |
| INC-01 | Hold/fail the publication preceding prompt or steer | Provider receives nothing until successful publication; failure reaches caller |
| INC-02 | Hold attach, start prompt, then close | No SDK send after close; late handle disposed |
| INC-03 | Several individually valid transcripts exceed aggregate limit | Essential records are published or an explicit failure is returned |
| INC-04 | Create and inspect published state without shutdown | Same ID/client key/composer survives |
| INC-05 | Cancel before Pi preflight accepts | Cancel remains owned by that turn and eventually takes effect |
| INC-06 | Restore Cursor/Grok saved image draft | Image survives hydration and the next save |
| INC-07 | Exceed steer count/byte capacity, then retry an old ID | State is bounded and no previously sent steer is sent again |
| INC-08 | Close then list/resume a completed conversation | Result matches the explicitly chosen retention policy |
| INC-09 | Parse malformed or unsafe message cursors | Equivalent routes return the agreed fallback consistently |

For INC-08, establish the current behavior without treating the product choice
as settled. Add the target-policy assertions with step 09 once that choice is
recorded. Unsupported vendor capabilities are explicit capability cases, not
silent skips or fake successful implementations.

## Fixture correctness requirements

- Deferred provider calls must be released or rejected in `finally`, including
  when an assertion fails. Teardown must not hang on its own deliberate fixture.
- Every promise launched by a fake or callback needs an observer. Keep the fatal
  rejection guard inert under tests, as the repository requires.
- Never use per-test replacement of the same module to obtain a fresh singleton.
  Prefer injected functions, spies, or separate isolated files/processes. The
  Bun-testing skill's stable-module guidance applies.
- Do not emit prompts, attachment data, or whole state snapshots into assertion
  logs. Assert counts, IDs from synthetic fixtures, statuses, and hashes/lengths.
- Test state-file permissions and bounded artifacts through the existing
  infrastructure rather than adding another unbounded log sink.
- A process fixture that is killed deliberately must report its expected signal
  separately from an assertion failure and clean up only its own process group.

## Baseline validation

The source review already ran the four relevant bridge HTTP/persistence files,
the web draft persistence file, and the aggregate suite successfully. Do not
repeat the entire suite solely to rediscover that fact on an unchanged revision.
Run the smallest new reproducer first, retain its failure explanation, implement
the owning fix, then run the package checks prescribed by that step.

Use this focused form, substituting the actual owning file:

```sh
mise run test:logged -- --name inconsistency-owner -- \
  bun test ./bridges/cursor-bridge/src/http.test.ts \
  --parallel=1 --only-failures
```

For new frontend tests use the web package working directory and its normal
preloads. For backend tests use `--preload ../../tests/setup-node.ts` from the
backend package as documented in the testing guide.

## Acceptance and handoff

- [ ] Each scheduled fix has a deterministic reproduction and an observable target.
- [ ] Fixture state cannot read or modify production sessions or credentials.
- [ ] Restart tests do not accidentally save the state they are supposed to prove.
- [ ] No unbounded logs, orphan fixture processes, or unstable module mocks are added.
- [ ] Failing reproductions are paired with fixes before their PR is considered green.
- [ ] The exact owner and test-file names are carried into the relevant step.

Do not expand this step into broad code cleanup, a vendor upgrade, or wholesale
deduplication of bridge implementations. Its deliverable is trustworthy evidence
and the minimum reusable fixture support to obtain it.

