import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";

/**
 * The per-window allocation of static document frames, separate from the
 * single executable interactive host.
 *
 * Ranks, highest first: an expanded document, one the reader is focused in or
 * has selected text in, a visible one, and one that scrolled out of view but
 * is still mounted. A frame that already holds a slot keeps it against an equal
 * rank, so scrolling does not churn reloads, and a held frame is released only
 * when another block needs its slot. Nothing claims a slot before it has been
 * visible, so a long history preloads nothing.
 */
export type StaticFrameRank = "expanded" | "interacting" | "visible" | "held";

const RANK_ORDER: Record<StaticFrameRank, number> = {
  expanded: 3,
  interacting: 2,
  visible: 1,
  held: 0,
};

interface Claim {
  rank: StaticFrameRank;
  order: number;
  granted: boolean;
}

const claims = new Map<string, Claim>();
const listeners = new Set<() => void>();
let nextOrder = 0;
let version = 0;
const counters = { framesMounted: 0, framesReloaded: 0, framesFailed: 0 };

function allocate(): void {
  const ordered = Array.from(claims.values()).sort(
    (a, b) =>
      RANK_ORDER[b.rank] - RANK_ORDER[a.rank] ||
      Number(b.granted) - Number(a.granted) ||
      a.order - b.order,
  );
  let changed = false;
  ordered.forEach((claim, index) => {
    const granted = index < STATIC_PRESENTATION_POLICY.maxFramesPerWindow;
    if (claim.granted !== granted) {
      claim.granted = granted;
      changed = true;
    }
  });
  // A held claim can retain its current slot, but cannot queue for a new one.
  for (const [id, claim] of Array.from(claims)) {
    if (claim.rank === "held" && !claim.granted) claims.delete(id);
  }
  if (changed) {
    version++;
    for (const listener of Array.from(listeners)) listener();
  }
}

export function setStaticFrameClaim(id: string, rank: StaticFrameRank | null): void {
  const existing = claims.get(id);
  if (rank === null) {
    if (!existing) return;
    claims.delete(id);
  } else if (existing) {
    if (existing.rank === rank) return;
    existing.rank = rank;
  } else {
    if (rank === "held") return;
    claims.set(id, { rank, order: nextOrder++, granted: false });
  }
  allocate();
}

export function staticFrameSlotGranted(id: string): boolean {
  return claims.get(id)?.granted === true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readVersion = () => version;

/**
 * Hold a claim while mounted. `rank` is the claim's current rank; `"held"`
 * keeps a slot this block already has and never asks for a new one.
 */
export function useStaticFrameSlot(id: string, rank: StaticFrameRank | null): boolean {
  useSyncExternalStore(subscribe, readVersion, readVersion);
  const granted = staticFrameSlotGranted(id);
  const claim = rank === "held" && !claims.has(id) ? null : rank;
  useLayoutEffect(() => {
    setStaticFrameClaim(id, claim);
  }, [id, claim]);
  useEffect(
    () => () => {
      setStaticFrameClaim(id, null);
    },
    [id],
  );
  return granted;
}

/** Content-free counters for the performance fixture and tests. */
export function noteStaticFrameEvent(event: keyof typeof counters): void {
  counters[event]++;
}

export function staticFrameSlotStats(): {
  claims: number;
  granted: number;
  framesMounted: number;
  framesReloaded: number;
  framesFailed: number;
} {
  let granted = 0;
  for (const claim of claims.values()) if (claim.granted) granted++;
  return { claims: claims.size, granted, ...counters };
}

/** Tests only. */
export function resetStaticFrameSlots(): void {
  claims.clear();
  nextOrder = 0;
  counters.framesMounted = 0;
  counters.framesReloaded = 0;
  counters.framesFailed = 0;
  version++;
  for (const listener of Array.from(listeners)) listener();
}
