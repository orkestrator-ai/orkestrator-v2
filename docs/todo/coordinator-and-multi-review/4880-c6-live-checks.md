# Live checks for a coordinator conversation that failed to start

## Task analysis

Analysed 2026-11-05 against main at 0194a0675, with coordinator batch C6 (Errors and dead ends) applied.

### Tasks

3. **A real older renderer against this backend**: needs an older build running. Status: open.

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

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (tasks 1 and 2, the signed-in provider runs) moved there on 2026-11-10.
