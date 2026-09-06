import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronUp, Loader2, X } from "lucide-react";
import { getTerminalHistoryPage, type TerminalHistoryPage } from "@/lib/backend";

const MAX_CACHED_PAGES = 16;
const MAX_CACHED_BYTES = 4 * 1024 * 1024;

export function TerminalHistoryPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [pages, setPages] = useState<TerminalHistoryPage[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pendingAnchorRef = useRef<{ height: number; top: number } | null>(null);

  const load = useCallback(
    async (requestedCursor?: string) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      const request = ++requestRef.current;
      if (requestedCursor && scrollerRef.current) {
        pendingAnchorRef.current = {
          height: scrollerRef.current.scrollHeight,
          top: scrollerRef.current.scrollTop,
        };
      }
      setLoading(true);
      setError(null);
      try {
        const page = await getTerminalHistoryPage(sessionId, requestedCursor);
        if (request !== requestRef.current) return;
        if (!page) {
          setError("Terminal history is no longer available.");
          return;
        }
        setPages((existing) => {
          const combined = (requestedCursor ? [page, ...existing] : [page]).slice(
            -MAX_CACHED_PAGES,
          );
          let bytes = 0;
          const retained: TerminalHistoryPage[] = [];
          for (let index = combined.length - 1; index >= 0; index -= 1) {
            const candidate = combined[index]!;
            const pageBytes = candidate.rows.reduce(
              (sum, row) => sum + new TextEncoder().encode(row.text).length,
              0,
            );
            if (retained.length > 0 && bytes + pageBytes > MAX_CACHED_BYTES) break;
            bytes += pageBytes;
            retained.unshift(candidate);
          }
          return retained;
        });
        setCursor(page.previousCursor);
      } catch (caught) {
        if (request === requestRef.current) {
          setError(
            caught instanceof Error ? caught.message : "Terminal history could not be loaded.",
          );
        }
      } finally {
        if (request === requestRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [sessionId],
  );
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    loadingRef.current = false;
    void loadRef.current();
    return () => {
      requestRef.current += 1;
    };
  }, [sessionId]);

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    const scroller = scrollerRef.current;
    if (!anchor || !scroller) return;
    pendingAnchorRef.current = null;
    scroller.scrollTop = scroller.scrollHeight - anchor.height + anchor.top;
  }, [pages]);

  const firstPage = pages[0];
  return (
    <section
      aria-label="Earlier terminal output"
      className="absolute inset-3 z-30 flex flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950/98 shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">Earlier terminal output</h2>
          <p className="text-xs text-zinc-400">Read-only backend history</p>
        </div>
        <button
          type="button"
          aria-label="Return to live terminal"
          onClick={onClose}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <button
          type="button"
          disabled={loading || cursor === null}
          onClick={() => cursor && void load(cursor)}
          className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ChevronUp className="h-3 w-3" />
          )}
          Load earlier
        </button>
        {cursor === null && (
          <span className="text-xs text-zinc-500">Start of retained history</span>
        )}
        {(firstPage?.historyTruncated || firstPage?.historyGap) && (
          <span role="status" className="text-xs text-amber-400">
            {firstPage.historyGap ? "Archive has a gap" : "Older output expired"}
          </span>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="border-b border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300"
        >
          {error}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void load(cursor ?? undefined)}
          >
            Retry
          </button>
        </div>
      )}
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-5 text-zinc-300"
      >
        {pages
          .flatMap((page) => page.rows)
          .map((row) => (
            <div key={row.id} className="whitespace-pre-wrap break-words">
              {row.text || " "}
            </div>
          ))}
        {!loading && pages.length === 0 && !error && (
          <p className="text-zinc-500">No retained output.</p>
        )}
      </div>
    </section>
  );
}
