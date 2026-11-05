# Live checks for the Work panel's remote and running paths

## Task analysis

Analysed 2026-11-05 against main at d5294b202, with coordinator batch C7 (Work panel and navigation) applied.

### Tasks

1. **Two nodes: a remote worker's prompt in the banner**: needs two real nodes. Status: open.
2. **A real running turn: Stop from a Work row**: needs a billed provider turn. Status: open.
3. **A real wake: the Coordinator report cue**: needs a billed provider turn and audio. Status: open.

### 1. Two nodes: a remote worker's prompt in the banner

**Problem.** A remote worker's sign-in link and code are read and drawn in tests with fakes only, so nothing has shown the hint and the read working across a real node link.

**Context.** From coordinator report C7, part `0280` (Remote workers' sign-in prompts never reach the banner), its Needs verification section: "Whether a remote worker's prompt reaches the user by any other route in practice; needs two nodes." C7 implemented the read (`useRemoteHumanPrompts.ts`) and passed its security check ([Work panel](../../architecture/coordinator.md#work-panel)); that work's constraints forbade contacting other real nodes.

**Investigation.** Covered by fakes: `useRemoteHumanPrompts.test.tsx` (hint, resync, summary refresh, older node, unavailable node, untrusted answers). Not covered: `human-prompt` hints through `watch_node_events` on a real link, and whether Open reaches the tab through `openMachineWorkspace`. The notice to the coordinator stays local (`noteWorkerHumanPrompt` filters out `nodeId`), so the banner is the only route.

**Decisions.**

- **How to check it?**
  - **Run `gh auth login` in a worker on a real leaf and watch the command node's panel (recommended).**
    - Pros: the real detection, hint and link; no provider cost beyond the turn that runs the command.
    - Cons: needs two machines and a turn.
  - **Extend the Docker or scenario suites with a second backend.**
    - Pros: repeatable.
    - Cons: a harness for one path; it would still not be a real link between machines.

### 2. A real running turn: Stop from a Work row

**Problem.** Stop has been exercised against a scripted provider and, in the real renderer, only against an idle tab.

**Context.** From coordinator report C7, part `0260`, task 2. That work forbade billed provider turns, and its isolated profile ran with no credentials.

**Investigation.** `coordinator-worker-turns.test.ts` and `coordinator-worker-turns-remote.test.ts` cover the command with a scripted provider. On an isolated, credential-free `dev:test` profile on 2026-11-05, Stop in the real renderer reached the backend through the gateway and answered the idle case ("That worker has no running turn to stop"), so the route is proven and only a real abort is not.

**Decisions.**

- **How to check it?**
  - **Start a long worker turn on a dev profile with credentials, press Stop, and read the coordinator's notice (recommended).**
    - Pros: covers the provider's abort and the wake's wording.
    - Cons: costs two provider turns: the worker's and the coordinator's wake.
  - **Rely on the scripted provider.**
    - Pros: no cost.
    - Cons: an abort is provider behaviour that a script only asserts.

### 3. A real wake: the Coordinator report cue

**Problem.** The cue is tested from a simulated event, so nobody has heard it follow a real wake, or checked how it sits next to the "agent stopped" cue a few seconds earlier.

**Context.** From coordinator report C7, part `0450`, task 2. The 500 ms coalescing covers only cues that arrive together. A worker's stop and the wake can be further apart.

**Investigation.** `useNotificationSoundService.test.tsx` covers once per wake, quiet on screen, and a hidden page. `SoundsSettings` previews the sound. Browsers also require a user gesture before Web Audio plays. A wake on a credential-free profile ends at "Not logged in", so that profile cannot show a real report arriving.

**Decisions.**

- **What should happen if the two cues sound like too much?**
  - **Leave both on and decide after listening (recommended).**
    - Pros: each has its own setting, so a user can already turn either off.
    - Cons: two cues for one finished worker when its environment is not on screen.
  - **Suppress "agent stopped" for a delegated worker.**
    - Pros: one cue per finished delegation.
    - Cons: the backend would have to tell the client which workers are delegated, or hold the cue until it knows.

## Related

- [The Work panel](../../architecture/coordinator.md#work-panel)
