/**
 * Asynchronous result providers for the palette (history today; any provider
 * whose answer arrives later). Each provider reports its own state
 * (`loading`, `ready`, `partial`, `failed`), so one slow or failed source
 * never blanks the others, and every answer is tagged with the generation of
 * the query that asked for it: an answer for an older query is discarded,
 * and the older request is aborted, rather than replacing newer rows.
 *
 * Selection is by row identity (`selection.ts`), so a late answer that adds
 * rows never moves the highlight or changes what Enter opens.
 */

export type PaletteProviderStatus = "idle" | "loading" | "ready" | "partial" | "failed";

export interface PaletteProviderAnswer<Row> {
  rows: Row[];
  /** More matched than the provider looked at or returned (a bounded scan). */
  partial: boolean;
}

export interface PaletteProvider<Row> {
  search: (query: string, signal: AbortSignal) => Promise<PaletteProviderAnswer<Row>>;
}

export interface PaletteProviderState<Row> {
  status: Exclude<PaletteProviderStatus, "idle" | "loading">;
  rows: Row[];
  /** The query generation these rows answer. */
  generation: number;
  /** The caller's key for the request these rows answer (its query and scope). */
  key: string;
}

/**
 * What a provider shows for the request `key`: its answer when the latest
 * answer is for that request, else `loading`. Deriving it (rather than
 * storing "loading" when a query starts) keeps a stale answer from ever
 * being shown under a newer query.
 */
export function providerView<Row>(
  state: PaletteProviderState<Row> | null,
  key: string | null,
): { status: PaletteProviderStatus; rows: Row[] } {
  if (key === null) return { status: "idle", rows: [] };
  if (!state || state.key !== key) return { status: "loading", rows: [] };
  return { status: state.status, rows: state.rows };
}

/**
 * Runs one provider for a sequence of queries. `run` starts a new
 * generation and aborts the previous request; `dispose` stops it for good.
 * The owner calls `dispose` (a component's effect cleanup, a test's
 * `afterEach`): nothing here outlives it.
 */
export class PaletteQueryRunner<Row> {
  private generation = 0;
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(
    private readonly provider: PaletteProvider<Row>,
    private readonly onState: (state: PaletteProviderState<Row>) => void,
  ) {}

  /**
   * Ask for `query`; `key` identifies the request to the caller. The state is
   * only ever reported asynchronously, and only for the latest request.
   */
  run(query: string, key: string): void {
    if (this.disposed) return;
    this.controller?.abort();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    // A provider that throws synchronously fails the same way as one that rejects.
    const answer = Promise.resolve().then(() => this.provider.search(query, controller.signal));
    answer.then(
      (result) => {
        if (!this.current(generation, controller)) return;
        this.onState({
          status: result.partial ? "partial" : "ready",
          rows: result.rows,
          generation,
          key,
        });
      },
      () => {
        if (!this.current(generation, controller)) return;
        this.onState({ status: "failed", rows: [], generation, key });
      },
    );
  }

  /** Abort the request in flight; its answer, if any, is discarded. */
  cancel(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  private current(generation: number, controller: AbortController): boolean {
    return !this.disposed && generation === this.generation && !controller.signal.aborted;
  }
}

/** Resolves on a later task, rejecting once `signal` aborts, so a long scan yields to typing. */
export function yieldToInput(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 0);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
