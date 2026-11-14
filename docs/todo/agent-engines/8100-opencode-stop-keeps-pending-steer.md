# A stopped OpenCode turn keeps its pending steer for the next turn

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf`.

### Tasks

1. **Decide what a stop does to a steer still in the inbox, and do it**: today OpenCode 2.2.6 keeps it and delivers it ahead of the next prompt. Status: open.

### 1. Decide what a stop does to a steer still in the inbox, and do it

**Problem.** A steer sent to a running OpenCode turn waits in the session's inbox until the next step boundary. When the turn is stopped first (most likely while it is parked on a permission or question card, where no step boundary comes until the card is answered), the stop rejects the card and ends the run, but the steer stays in the inbox. The next prompt then starts a run that delivers the old steer first and the new prompt after it, so the model answers a redirect the user aimed at a turn they then stopped.

**Context.** The provider's `abort` (`apps/backend/src/core/opencode2/provider.ts`) interrupts the run and rejects parked permissions and forms; it does not touch the inbox. Steers carry `metadata.orkestrator.steer: true`, so the provider can tell them from other input. `OpenCode2Client.withdrawInput` (`DELETE /api/session/:id/inbox/:inputId`) already exists. `steerStatus` answers `dispatched` while the steer is in the inbox, so a withdrawn steer would then read `unknown`. The public CLI documents a steer as a receipt, not a run ([public-cli.md](../../architecture/public-cli.md)).

**Investigation.** Observed on 2026-11-14 against the pinned 2.2.6 on beelink2 and pinned by `opencode2-steer-cards.live.test.ts` ("a stop leaves a parked run's steer in the inbox, and the next run delivers it first"): after the stop the inbox still held the steer, the model had not seen it, and the next prompt's history read `user:<steer>`, `ack:<steer>`, `user:<next prompt>`, `ack:<next prompt>` in one run. Found while doing 7905 task 3.

**Decisions.**

- **What should a stop do to a pending steer?**
  - **Withdraw Orkestrator's own steers from the inbox as part of the stop (recommended).**
    - Pros: a stop means the turn and its redirects are over, which is what Claude and Codex already do with a steer their turn never took; the user's next prompt runs alone; one place, in `abort`, after the interrupt.
    - Cons: a withdrawn steer was reported `applied`; its status must read as not delivered (the live test changes, and the composer should not show it as delivered); a withdraw that fails leaves today's behaviour.
  - **Keep it, and tell the user it will go with the next turn.**
    - Pros: nothing typed is lost.
    - Cons: a notice nobody else needs, for a redirect aimed at a turn that no longer exists.
  - **Leave it.**
    - Pros: no change.
    - Cons: the next turn answers stale input first.

## Related

- [7905](7905-opencode2-untested-paths.md) task 3, where this was found.
- [0005](0005-mid-turn-steer-and-interrupt.md): steer and interrupt across providers.
