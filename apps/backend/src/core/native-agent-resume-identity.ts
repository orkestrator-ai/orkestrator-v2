import type { PersistedNativeAgentSession } from "./models.js";
import type { StorageService } from "./storage.js";

type IdentitySnapshot = { status?: unknown; resumableSessionId?: unknown };

/**
 * Order snapshot reads and their captures together, across full and progressive
 * views. Supplementary projection work never holds this lane. No older read
 * can finish after a newer read and replace its thread identity.
 */
export class NativeAgentResumeIdentityObserver {
  private readonly pending = new Map<string, { tail: Promise<unknown>; count: number }>();
  private count = 0;

  constructor(
    private readonly storage: Pick<StorageService, "recordNativeAgentSessionResumeIdentity">,
  ) {}

  read<T extends IdentitySnapshot>(
    session: PersistedNativeAgentSession,
    read: () => Promise<T>,
  ): Promise<T> {
    const key = `${session.key}\0${session.providerSessionId}`;
    const previous = this.pending.get(key);
    if ((previous?.count ?? 0) >= 32 || this.count >= 512) {
      return Promise.reject(new Error("Native agent identity read is overloaded"));
    }
    const observe = async () => {
      const snapshot = await read();
      if (snapshot.status !== "missing" && typeof snapshot.resumableSessionId === "string") {
        const resumable = snapshot.resumableSessionId.trim();
        if (resumable) {
          // A successful state read waits for its durable fallback. Storage
          // failures remain best effort so they do not hide a live transcript.
          await this.storage
            .recordNativeAgentSessionResumeIdentity(
              session.key,
              session.providerSessionId,
              resumable,
            )
            .catch(() => undefined);
        }
      }
      return snapshot;
    };
    const entry = {
      tail: Promise.resolve() as Promise<unknown>,
      count: (previous?.count ?? 0) + 1,
    };
    this.count += 1;
    const operation = previous ? previous.tail.then(observe, observe) : observe();
    entry.tail = operation.finally(() => {
      this.count -= 1;
      const current = this.pending.get(key);
      if (current === entry) this.pending.delete(key);
      else if (current) current.count -= 1;
    });
    this.pending.set(key, entry);
    return entry.tail as Promise<T>;
  }
}
