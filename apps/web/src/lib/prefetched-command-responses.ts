/**
 * Short-lived answers for reads the backend already batched.
 *
 * Scoped reconciliation asks the backend for the snapshots its change list
 * implies, then runs the ordinary refetch handlers. Priming those answers here
 * lets each handler keep calling the same command it always did while the
 * round trips collapse into one batch.
 *
 * The entries are a cache in front of a *global* command surface, so their
 * lifetime is deliberately narrow. Anything that could have changed the
 * resource behind a primed snapshot must drop it rather than let a stale
 * batch-time value answer a later read: a mutation invalidates the whole map,
 * and every entry expires on its own shortly after the batch that produced it.
 */

interface PrefetchedEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * How long a primed snapshot may answer a read.
 *
 * Sized for one reconciliation pass, not for reuse: delivery for a full
 * manifest page is bounded by its handlers, and anything slower should pay a
 * fresh read rather than serve a value the backend may already have replaced.
 */
export const PREFETCHED_COMMAND_RESPONSE_TTL_MS = 10_000;

/**
 * Commands that only read. Anything else is treated as a mutation and drops
 * every primed snapshot, because a command this module cannot classify may
 * have changed any of them.
 */
const READ_COMMAND_PATTERN = /^(get|list|read|has|is)_/;

function prefetchKey(command: string, args: Record<string, unknown> | undefined): string {
  return `${command}\0${JSON.stringify(args ?? {})}`;
}

/**
 * One cache per backend-bound command surface. Identical reads on two
 * backends are different answers, so a federated client gives each backend
 * runtime its own instance; nothing here is keyed by anything but the
 * command and its arguments, which is only safe inside one backend.
 */
export class PrefetchedCommandCache {
  private readonly entries = new Map<string, PrefetchedEntry>();

  prime(
    entries: ReadonlyArray<{ command: string; args: Record<string, unknown>; snapshot: unknown }>,
    options: { ttlMs?: number } = {},
  ): () => void {
    const expiresAt = Date.now() + (options.ttlMs ?? PREFETCHED_COMMAND_RESPONSE_TTL_MS);
    const keys = entries.map((entry) => prefetchKey(entry.command, entry.args));
    entries.forEach((entry, index) => {
      this.entries.set(keys[index]!, { value: entry.snapshot, expiresAt });
    });
    return () => {
      for (const key of keys) this.entries.delete(key);
    };
  }

  read(
    command: string,
    args: Record<string, unknown> | undefined,
  ): { found: boolean; value?: unknown } {
    const key = prefetchKey(command, args);
    const entry = this.entries.get(key);
    if (!entry) return { found: false };
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return { found: false };
    }
    return { found: true, value: structuredClone(entry.value) };
  }

  /**
   * Called for every invocation a primed snapshot did not answer. A mutation
   * invalidates the whole cache: this module knows which reads it can serve,
   * but not which writes invalidate which of them, and answering a read with
   * a snapshot taken before a write the client itself issued is the one
   * failure mode a cache in front of a command surface must not have.
   */
  noteInvocation(command: string): void {
    if (this.entries.size === 0) return;
    if (READ_COMMAND_PATTERN.test(command)) return;
    this.entries.clear();
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * The single-backend facade's cache. Each renderer realm talks to exactly one
 * backend through `@/lib/native/backend`, so one instance per realm is
 * correct there; federated runtimes own their own `PrefetchedCommandCache`.
 */
const defaultCache = new PrefetchedCommandCache();

export function primePrefetchedCommandResponses(
  entries: ReadonlyArray<{ command: string; args: Record<string, unknown>; snapshot: unknown }>,
  options: { ttlMs?: number } = {},
): () => void {
  return defaultCache.prime(entries, options);
}

export function readPrefetchedCommandResponse(
  command: string,
  args: Record<string, unknown> | undefined,
): { found: boolean; value?: unknown } {
  return defaultCache.read(command, args);
}

/** See {@link PrefetchedCommandCache.noteInvocation}. */
export function notePrefetchedCommandInvocation(command: string): void {
  defaultCache.noteInvocation(command);
}

/** Drops every primed snapshot. Used by teardown and by tests. */
export function clearPrefetchedCommandResponses(): void {
  defaultCache.clear();
}
