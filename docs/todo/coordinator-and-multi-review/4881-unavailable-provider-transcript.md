# A conversation whose platform is unavailable does not load its transcript

## Task analysis

Analysed 2026-11-05 against main at 0194a0675, with coordinator batch C6 (Errors and dead ends) applied.

### Tasks

1. **Load the transcript while a conversation's platform is unavailable**: read saved history as a paused pane does. Status: open.

### 1. Load the transcript while a conversation's platform is unavailable

**Problem.** After a reload, a conversation whose platform is turned off or held back by the safety level shows an empty composer, not its transcript. The comment above its banner says the conversation stays readable.

**Context.** Found while building coordinator report C6, part `0200`, whose task covers only a paused or failed conversation. The pane keeps `connectionEnabled` false for this case (`CoordinatorConversationPane.tsx`).

**Investigation.** Seen on an isolated profile on 2026-11-05 with an unavailable platform routed into the snapshot: the banner and its Coordinator settings button show, and the pane reads "Ready to build!". `heldCoordinatorConversation` does not cover this case, so a transcript read would reach the provider path and be refused by `resolveCoordinatorRuntime` as `unsupported-agent`.

**Decisions.**

- **How to hold it?**
  - **Add the unavailable platform to `heldCoordinatorConversation` and pass `sendingHeldReason` from the pane (recommended).**
    - Pros: one rule for every conversation that may be read but not run, and the banner's promise holds.
    - Cons: each held check also reads the configuration and asks for the qualification, for every coordinator read.
  - **Leave it, and correct the comment.**
    - Pros: no extra read.
    - Cons: the user sees nothing of a conversation they can only get back by changing a setting.
