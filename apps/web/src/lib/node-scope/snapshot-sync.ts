/**
 * Whether a node scope shows authoritative data or a local snapshot that is
 * being replaced (plan item 4003, report §8.3).
 *
 * A scope hydrated from its snapshot is marked `resyncing` with the
 * collections it is waiting for. Each authoritative read that lands for one of
 * them (`noteAuthoritativeRead`) takes it off the list; when the list is empty
 * the scope is `live`. A scope that was never hydrated from a snapshot is
 * `live` from the start, so nothing changes for it.
 *
 * While a scope is `resyncing`, its mutations wait (`scopeMutationGate`,
 * consulted by `invokeInScope` for every command that is not a read): an
 * action taken on the snapshot's picture of the node must not reach the node
 * before the picture is current. The wait is bounded; past it, or when the
 * scope is disposed, the mutation is refused with `ScopeResyncingError`.
 *
 * Plain code over a signal, deliberately not part of `NodeScope` itself: the
 * tier (plan item 4002) and the connection state are separate axes, and this
 * one only exists for scopes that were painted from a snapshot.
 */

import type { ReadableSignal } from "@orkestrator/protocol/node-client";
import * as Data from "effect/Data";
import type { NodeScope } from "./node-scope";
import { createSignal, type WritableSignal } from "./signal";

/** The collections whose authoritative read makes a snapshot-hydrated scope `live`. */
export type SnapshotGatedKind = "project" | "environment" | "config";

export const SNAPSHOT_GATED_KINDS: readonly SnapshotGatedKind[] = Object.freeze([
  "project",
  "environment",
  "config",
]);

export type ScopeSnapshotSync =
  | { readonly state: "live" }
  | {
      readonly state: "resyncing";
      /** When the snapshot shown was captured (epoch ms). */
      readonly savedAt: number;
      /** Collections still waiting for their authoritative read. */
      readonly pending: readonly SnapshotGatedKind[];
    };

const LIVE: ScopeSnapshotSync = Object.freeze({ state: "live" });

/** How long a mutation waits for `live` before it is refused. */
export const SNAPSHOT_MUTATION_WAIT_MS = 30_000;

/** A mutation was refused because the scope's data was still being replaced. */
export class ScopeResyncingError extends Data.TaggedError("ScopeResyncingError")<{
  readonly nodeId: string;
  readonly reason: "timeout" | "disposed";
  readonly message: string;
}> {}

interface SyncEntry {
  readonly signal: WritableSignal<ScopeSnapshotSync>;
  /** Kinds with an authoritative read since the scope opened, hydrated or not. */
  readonly seen: Set<SnapshotGatedKind>;
  /** Mutations waiting for `live`; told when the scope is disposed. */
  readonly waiters: Set<() => void>;
  disposeHooked: boolean;
}

const entries = new WeakMap<NodeScope, SyncEntry>();

function entryFor(scope: NodeScope): SyncEntry {
  let entry = entries.get(scope);
  if (!entry) {
    entry = {
      signal: createSignal(LIVE),
      seen: new Set(),
      waiters: new Set(),
      disposeHooked: false,
    };
    entries.set(scope, entry);
  }
  return entry;
}

/** The scope's snapshot state; `live` for a scope never hydrated from a snapshot. */
export function scopeSnapshotSync(scope: NodeScope): ReadableSignal<ScopeSnapshotSync> {
  return entryFor(scope).signal;
}

/**
 * Marks `scope` as showing a snapshot captured at `savedAt`, waiting for
 * `kinds` (those already read authoritatively are not waited for).
 */
export function markScopeResyncing(
  scope: NodeScope,
  savedAt: number,
  kinds: readonly SnapshotGatedKind[] = SNAPSHOT_GATED_KINDS,
): void {
  if (scope.disposed) return;
  const entry = entryFor(scope);
  const pending = kinds.filter((kind) => !entry.seen.has(kind));
  if (!entry.disposeHooked) {
    entry.disposeHooked = true;
    scope.onDispose("snapshot-sync", () => {
      for (const waiter of Array.from(entry.waiters)) waiter();
    });
  }
  entry.signal.set(
    pending.length === 0 ? LIVE : Object.freeze({ state: "resyncing", savedAt, pending }),
  );
}

/** An authoritative read of `kind` landed in `scope`'s stores. */
export function noteAuthoritativeRead(scope: NodeScope, kind: SnapshotGatedKind): void {
  const entry = entryFor(scope);
  entry.seen.add(kind);
  const current = entry.signal.get();
  if (current.state !== "resyncing" || !current.pending.includes(kind)) return;
  const pending = current.pending.filter((other) => other !== kind);
  entry.signal.set(pending.length === 0 ? LIVE : Object.freeze({ ...current, pending }));
}

/** Whether every kind in `kinds` has had an authoritative read in `scope`. */
export function hasAuthoritativeReads(
  scope: NodeScope,
  kinds: readonly SnapshotGatedKind[] = SNAPSHOT_GATED_KINDS,
): boolean {
  const seen = entries.get(scope)?.seen;
  return seen !== undefined && kinds.every((kind) => seen.has(kind));
}

export interface WhenLiveOptions {
  readonly timeoutMs?: number;
}

/**
 * Resolves when `scope` is `live` (at once if it is), rejects with
 * `ScopeResyncingError` past `timeoutMs` or when the scope is disposed. Its
 * timer and listener are removed on every outcome (invariant 15).
 */
export function whenScopeLive(scope: NodeScope, options: WhenLiveOptions = {}): Promise<void> {
  const entry = entryFor(scope);
  if (entry.signal.get().state === "live") return Promise.resolve();
  if (scope.disposed) return Promise.reject(resyncingError(scope, "disposed"));
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_MUTATION_WAIT_MS;
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: ScopeResyncingError) => {
      clearTimeout(timer);
      unsubscribe();
      entry.waiters.delete(onDisposed);
      if (error) reject(error);
      else resolve();
    };
    const onDisposed = () => finish(resyncingError(scope, "disposed"));
    const unsubscribe = entry.signal.subscribe((next) => {
      if (next.state === "live") finish();
    });
    const timer = setTimeout(() => finish(resyncingError(scope, "timeout")), timeoutMs);
    entry.waiters.add(onDisposed);
  });
}

function resyncingError(scope: NodeScope, reason: "timeout" | "disposed"): ScopeResyncingError {
  return new ScopeResyncingError({
    nodeId: scope.nodeId,
    reason,
    message:
      reason === "timeout"
        ? "This machine's data is still being refreshed. Try again in a moment."
        : "This machine's workspace was closed before its data was refreshed.",
  });
}

/**
 * The wait a mutation on `scope` must take, or `null` when it may go now.
 * `invokeInScope` calls it for every command that is not a read.
 */
export function scopeMutationGate(scope: NodeScope): Promise<void> | null {
  const entry = entries.get(scope);
  if (!entry || entry.signal.get().state === "live") return null;
  return whenScopeLive(scope);
}
