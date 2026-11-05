# Live checks for a coordinator conversation that failed to start

## Task analysis

Analysed 2026-11-05 against main at 0194a0675, with coordinator batch C6 (Errors and dead ends) applied.

### Tasks

1. **Retry against a real provider, with mail waiting**: needs a real provider session. Status: open.
2. **A real failed side beside a real running main**: needs a billed provider turn. Status: open.
3. **A real older renderer against this backend**: needs an older build running. Status: open.

### 1. Retry against a real provider, with mail waiting

**Problem.** Nothing has shown Retry reconnecting a real provider session and then delivering mail that waited while the conversation had failed.

**Context.** From coordinator report C6, part `0020`, tasks 1 and 2. That work forbade billed provider turns, and its isolated profile ran with no credentials.

**Investigation.** On an isolated, credential-free `dev:test` profile on 2026-11-05, Retry cleared `startupError`, the pane sent `adopt_native_agent_session` and `ensure_native_agent_session`, and a real Claude bridge started and recorded its port. The seeded provider session was not a real one, so the pane then showed its connection failure, and no prompt was sent. `agent-mail-service.test.ts` covers holding the mail with a scripted dispatch. Not covered: delivery after a real Retry.

**Decisions.**

- **How to check it?**
  - **On a dev profile with credentials, make a side conversation's bridge fail once, mail it, press Retry and read the wake (recommended).**
    - Pros: covers the real resume and the real delivery.
    - Cons: costs one provider turn, the wake.
  - **Rely on the scripted provider.**
    - Pros: no cost.
    - Cons: a resume is provider behaviour that a script only asserts.

### 2. A real failed side beside a real running main

**Problem.** The promise that the main carries on is tested per check with fakes, not seen with a real turn running while a sibling fails.

**Context.** From coordinator report C6, part `0020`, task 1. Its Needs verification section under part `0200` asks for the startup-error state to be looked at for real.

**Investigation.** `commands-servers-coordinator.test.ts` fails a real child process and reads the stored result. `control-mcp-server.test.ts`, `agent-mail-service.test.ts`, `coordinator-runtime.test.ts` and `native-agent-service-held-coordinator.test.ts` cover each check. The panel state was seeded on the isolated profile and not produced by a real failing start beside a running main.

**Decisions.**

- **How to check it?**
  - **Run a long main turn with a broken side bridge on a dev profile with credentials, and check the main's tools and mail still work (recommended).**
    - Pros: the one thing the batch set out to fix, seen end to end.
    - Cons: costs one provider turn and needs a way to break only the side's bridge.
  - **Add it to the live coordinator suite.**
    - Pros: repeatable.
    - Cons: a billed scenario on every run of that suite.

### 3. A real older renderer against this backend

**Problem.** The mixed-version path is tested by the shape an older client reads, not with an older client.

**Context.** From coordinator report C6, part `0020`, task 1. `docs/architecture/version-compatibility.md` holds the rows and the removal condition.

**Investigation.** `coordinator-service.test.ts` covers the workspace field an older renderer reads and the `ensure` it sends. `coordinator-runtime.test.ts` covers the refusal it shows. No older build was run, because the batch could not contact other real nodes or install a release.

**Decisions.**

- **How to check it?**
  - **Open a browser tab from a release before C6, upgrade the backend under it, and fail a conversation (recommended).**
    - Pros: the real pairing the window promises.
    - Cons: needs a release build and an upgrade on a throwaway profile.
  - **Leave it to the usage counter `coordinator-ensure.conversation-errors-cleared`.**
    - Pros: no work.
    - Cons: it shows that the path ran, not that it read well.
