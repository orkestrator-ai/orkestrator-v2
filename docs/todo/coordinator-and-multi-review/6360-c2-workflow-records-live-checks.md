# Live checks for workflow records on released and unreachable nodes

## Task analysis

Analysed 2026-11-05 against main at 41f9eb638, with coordinator batch C2 (Workflow records) applied.

### Tasks

4. **The workflow store banner on a live stack**: needs a store near its limit on an isolated profile. Status: open.

### 4. The workflow store banner on a live stack

**Problem.** The banner was screenshotted as the real component with the app's compiled styles, not inside a running app with a store near its limit.

**Context.** From coordinator report C2, part `0080`, task 2. Filling the store needs about 1,800 records still in use, which no fixture seeds.

**Investigation.** `CoordinatorWorkflowStoreBanner.test.tsx` covers the three states; `coordinator-workflow-retention.test.ts` covers the snapshot state on a real store; `coordinator-node-release.test.ts` reads `workflowStore` from a real snapshot (`ok`). The banner's place in `CoordinatorWorkerPrompts` above the worker prompts was not seen live.

**Decisions.**

- **How to check it?**
  - **Add a `dev:test` fixture option that seeds in-use coordinator records, then open the panel at desktop and phone widths (recommended).**
    - Pros: repeatable, and it exercises the snapshot through the gateway.
    - Cons: a new fixture option to maintain.
  - **Seed records by hand into a disposable profile's store.**
    - Pros: no harness change.
    - Cons: writes a store behind the running backend's back, which the storage rules forbid.

## Related

- Architecture: [Workflow record limit and cleanup](../../architecture/coordinator.md#workflow-record-limit-and-cleanup) and [Work on a node that leaves](../../architecture/coordinator.md#work-on-a-node-that-leaves)
- [Workers' waiting prompts](../../architecture/coordinator.md#workers-waiting-prompts): the other C7 two-node check (to-do 4942, retired 2026-11-10)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (tasks 1, 2 and 3, the checks on real machines) moved there on 2026-11-10.
