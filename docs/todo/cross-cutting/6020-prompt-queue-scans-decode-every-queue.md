# Prompt queue scans still decode every queue

## Task analysis

Analysed 2026-11-05 against `main` at `6e796ca32`. Found while building 5100.

### Tasks

1. **Stop the scans decoding whole queues**: decide from a real store's numbers whether the scans need to change, and change them if so. Status: blocked (waits on 7568: 5101 task 1).

### 1. Stop the scans decoding whole queues

**Problem.** After 5100 single-queue mutations decode only their own row, but `listAllPromptQueues`, `listPromptQueues` and environment deletion through `deletePromptQueuesOwnedBy` still parse every row, attachments included. A queue holding up to 32 MiB of pasted attachments is decoded on the backend's event loop by each scan, though most scans read only a few fields.

**Context.** The callers are the native queue discovery (`discoverNativeQueues`, through `listQueues` in `native-agent-prompt-queue-dispatcher.ts`, by default every 30 s while idle), that dispatcher's `drainPromptQueues`, the tmux `PromptQueueDrainer.runSweep` (`prompt-queue-drainer.ts`), the job tab reuse's receipt search (`native-agent-job-tab-reuse.ts`) and the `list_prompt_queues` command (`commands-registry-prompts.ts`), which does need whole queues for the renderer. Environment deletion also uses `readStoredPromptQueues` to find owned rows, including damaged records; it remains a full-store scan.

**Investigation.** The record layout has no `owner` extractor (`storage-stores.ts`), so an environment's queues cannot be read through `loadStoreRowsByOwner` today, and existing rows carry a null owner. The scans filter on the key's agent, `messages.length`, `inFlight`, `dispatchError`, `outstandingClaim` and, in places, a receipt. Claim recovery changes those fields, so a summary must apply it too. In 5100's fixtures one full load was about 3.7 MiB for 2000 small queues and 30 MiB with one large queue. How often real stores hold a large queue is not known; the live store sizes of to-do 5101 (retired 2026-11-10) are in the manual-test checklist (7568: 5101 task 1).

**Decisions.**

- **What to do about the scans?**
  - **Measure a real store first, then keep a decoded per-row read model for the scans if the cost shows up (recommended).** `storage-frozen-snapshot.ts` re-parses only the rows whose serialized value changed.
    - Pros: no work unless the cost is real; an unchanged store costs one revision query; an existing pattern; recovery stays one code path.
    - Cons: retains decoded queues in memory, which needs the existing retained-size bound, and expiry-based claim recovery must still run on each read.
  - **Keep a summary column or row beside each queue.**
    - Pros: a scan never parses the message bodies.
    - Cons: a second source of truth an older backend's whole-value save would not maintain, so it fails the [version compatibility](../../architecture/version-compatibility.md) rule without a fallback.

## Constraints and rationale

A scan must apply the same claim recovery and validation as `loadPromptQueues`, and one unreadable row must keep costing only that row.

## Related

- `5100-prompt-queue-row-writes.md` (deleted 2026-11-06)
- to-do 5101 (retired 2026-11-10): live store sizes, now in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)

## Assumptions and decisions

### Scan scope (task 1)

Include environment deletion alongside listings when measuring the remaining scans. Its owner search parses every row today; retain corruption isolation and key-based ownership protection if that path changes. Single-queue writer performance is separate from this remaining scan work.
