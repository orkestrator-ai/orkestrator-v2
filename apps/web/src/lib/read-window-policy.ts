/**
 * The window half of read scheduling (plan item 3014, report §7.4): what one
 * renderer window knows regardless of which node a read goes to.
 *
 * - **Visibility.** The document's Page Visibility, plus its host's word that
 *   it is hidden (`setHostHidden`, plan item 0003: a page whose embedder
 *   hides it while its own Page Visibility still reads visible).
 * - **Data saving.** This client's preference (`setDataSaving`).
 * - **Return hints.** `focus` and `pageshow` (resume), and browser `online`
 *   (a network path came back: retry failed reads now).
 *
 * Each node scope has its own read coordinator (`readCoordinatorFor(scope)`
 * in `read-coordinator.ts`), holding that node's entries, connection identity,
 * connectivity and reconnect bookkeeping. Every one of them listens to this
 * policy, so the window's visibility and data-saving apply to all nodes at
 * once and a hidden window reads from none of them.
 *
 * The app has one policy (`getReadWindowPolicy()`), bound to the real document
 * and window on first use. Tests build their own with fakes.
 */

/** What changed. `visibility` is raised for every document `visibilitychange`. */
export type ReadWindowEvent =
  | { readonly kind: "visibility" }
  | { readonly kind: "data-saving"; readonly enabled: boolean }
  | { readonly kind: "hint"; readonly hint: "resume" | "reconnect" };

export type ReadWindowListener = (event: ReadWindowEvent) => void;

interface EventSourceLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ReadWindowVisibilitySource extends EventSourceLike {
  readonly visibilityState?: string;
}

export interface ReadWindowPolicyOptions {
  /** Document-like visibility source; `null` disables visibility handling. */
  document?: ReadWindowVisibilitySource | null;
  /** Window-like source for the `focus`, `pageshow` and `online` hints. */
  window?: EventSourceLike | null;
}

export interface ReadWindowPolicy {
  /** The document is hidden, or its host has said so. */
  isHidden(): boolean;
  hostHidden(): boolean;
  dataSaving(): boolean;
  /**
   * The host's word that this document is hidden although its own Page
   * Visibility says visible. Reads defer and resume as for a hidden document.
   */
  setHostHidden(hidden: boolean): void;
  /** This client's data-saving preference, for every node's reads. */
  setDataSaving(enabled: boolean): void;
  /** Listeners run synchronously, in subscription order. Returns the unsubscribe. */
  subscribe(listener: ReadWindowListener): () => void;
  /** Detaches from the document and window and drops every listener. Idempotent. */
  dispose(): void;
}

export function createReadWindowPolicy(options: ReadWindowPolicyOptions = {}): ReadWindowPolicy {
  const doc = options.document ?? null;
  const win = options.window ?? null;
  const listeners = new Set<ReadWindowListener>();
  let hostHidden = false;
  let dataSaving = false;
  let disposed = false;

  const emit = (event: ReadWindowEvent): void => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const onVisibilityChange = () => emit({ kind: "visibility" });
  const onFocus = () => emit({ kind: "hint", hint: "resume" });
  const onOnline = () => emit({ kind: "hint", hint: "reconnect" });
  doc?.addEventListener("visibilitychange", onVisibilityChange);
  win?.addEventListener("focus", onFocus);
  win?.addEventListener("pageshow", onFocus);
  win?.addEventListener("online", onOnline);

  return {
    isHidden: () => hostHidden || doc?.visibilityState === "hidden",
    hostHidden: () => hostHidden,
    dataSaving: () => dataSaving,
    setHostHidden(next) {
      if (hostHidden === next || disposed) return;
      hostHidden = next;
      emit({ kind: "visibility" });
    },
    setDataSaving(next) {
      if (dataSaving === next || disposed) return;
      dataSaving = next;
      emit({ kind: "data-saving", enabled: next });
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
      win?.removeEventListener("focus", onFocus);
      win?.removeEventListener("pageshow", onFocus);
      win?.removeEventListener("online", onOnline);
      listeners.clear();
    },
  };
}

let windowPolicy: ReadWindowPolicy | null = null;

/** This window's policy, bound to the real document and window on first use. */
export function getReadWindowPolicy(): ReadWindowPolicy {
  windowPolicy ??= createReadWindowPolicy({
    document: typeof document === "undefined" ? null : document,
    window: typeof window === "undefined" ? null : window,
  });
  return windowPolicy;
}

/**
 * Test seam: disposes the window policy. The next `getReadWindowPolicy()`
 * returns `policy` (a fake-backed one) or builds the real one.
 */
export function resetReadWindowPolicyForTests(policy?: ReadWindowPolicy): void {
  if (windowPolicy !== policy) windowPolicy?.dispose();
  windowPolicy = policy ?? null;
}
