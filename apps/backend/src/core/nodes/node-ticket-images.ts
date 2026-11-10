import { TICKET_SYNC_LIMITS } from "@orkestrator/protocol/ticket-sync";

/**
 * The leaf's side of images on synced tickets (docs/architecture/tickets.md,
 * "Sync across machines"). A leaf never reaches its command node, so when a
 * board here shows an image whose bytes are elsewhere it records a want,
 * announces it like queued ticket changes, and waits: the command node sees
 * the want when it collects (`wantedImages`) and delivers the bytes, or says
 * they are unavailable, with `put_ticket_image`. A want that is not answered
 * in time fails with the caller's message; nothing waits forever.
 */

interface Want {
  controllerId: string;
  message: string;
  waiters: Array<{ resolve: () => void; reject: (error: Error) => void }>;
  timer: ReturnType<typeof setTimeout>;
}

export interface LeafTicketImageWantsOptions {
  /** Tells the command node there is something to collect. */
  announce(controllerId: string): void;
  timeoutMs?: number;
  /** Wants held at once; a further one is refused at once. */
  maxWants?: number;
}

export class LeafTicketImageWants {
  private readonly wants = new Map<string, Want>();
  private disposed = false;

  constructor(private readonly options: LeafTicketImageWantsOptions) {}

  /**
   * Resolves once the command node has delivered `imageId`'s bytes here;
   * rejects with `unavailableMessage` when it cannot, or does not in time.
   */
  want(controllerId: string, imageId: string, unavailableMessage: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error(unavailableMessage));
    return new Promise<void>((resolve, reject) => {
      const existing = this.wants.get(imageId);
      if (existing) {
        existing.waiters.push({ resolve, reject });
        this.options.announce(existing.controllerId);
        return;
      }
      if (this.wants.size >= (this.options.maxWants ?? 200)) {
        reject(new Error(unavailableMessage));
        return;
      }
      const timer = setTimeout(
        () => this.settle(imageId, new Error(unavailableMessage)),
        this.options.timeoutMs ?? 20_000,
      );
      timer.unref?.();
      this.wants.set(imageId, {
        controllerId,
        message: unavailableMessage,
        waiters: [{ resolve, reject }],
        timer,
      });
      this.options.announce(controllerId);
    });
  }

  /** The images waiting for one command node, oldest first, bounded. */
  wanted(controllerId: string): string[] {
    const ids: string[] = [];
    for (const [imageId, want] of this.wants) {
      if (want.controllerId !== controllerId) continue;
      ids.push(imageId);
      if (ids.length >= TICKET_SYNC_LIMITS.maxWantedImages) break;
    }
    return ids;
  }

  /** The command node answered for `imageId`: its bytes are stored here, or it has none. */
  answered(controllerId: string, imageId: string, stored: boolean): void {
    const want = this.wants.get(imageId);
    if (!want || want.controllerId !== controllerId) return;
    this.settle(imageId, stored ? null : new Error(want.message));
  }

  /** Stops every timer and fails every want; the owner calls it on shutdown. */
  dispose(): void {
    this.disposed = true;
    for (const imageId of Array.from(this.wants.keys())) {
      this.settle(imageId, new Error(this.wants.get(imageId)!.message));
    }
  }

  private settle(imageId: string, error: Error | null): void {
    const want = this.wants.get(imageId);
    if (!want) return;
    this.wants.delete(imageId);
    clearTimeout(want.timer);
    for (const waiter of want.waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }
}
