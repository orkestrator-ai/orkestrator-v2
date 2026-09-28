import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";

/** Lines the view keeps; older ones scroll away. */
const MAX_LINES = 2_000;
const POLL_MS = 1_000;

type FollowState =
  | { kind: "connecting" }
  | { kind: "following" }
  | { kind: "ended" }
  | { kind: "disconnected"; message: string };

/**
 * Follows a container's log through the backend's shared follower. Output is
 * read by cursor (never pushed), so a hidden or remounted view simply reads
 * again; closing the view releases the subscription and nothing else. A gap
 * (output older than the backend kept) and the container stopping are shown
 * as such, not as a complete log.
 */
export function ContainerLogViewer({ containerId }: { containerId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<FollowState>({ kind: "connecting" });
  const [gaps, setGaps] = useState(0);
  const [generation, setGeneration] = useState(0);
  const scroller = useRef<HTMLPreElement | null>(null);

  const append = useCallback((records: Array<{ text: string }>, replace = false) => {
    if (records.length === 0 && !replace) return;
    setLines((current) => {
      const next = (replace ? [] : current).concat(records.map((record) => record.text));
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let subscriptionId: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setLines([]);
    setGaps(0);
    setState({ kind: "connecting" });

    const poll = async (sourceId: string, cursor: number) => {
      if (cancelled || !subscriptionId) return;
      try {
        const read = await backend.readContainerLogs(subscriptionId, sourceId, cursor);
        if (cancelled) return;
        if (read.kind === "gap") {
          setGaps((count) => count + 1);
          append(read.records, true);
        } else {
          append(read.records);
        }
        if (read.ended && read.records.length === 0) {
          setState({ kind: "ended" });
          return;
        }
        setState({ kind: "following" });
        timer = setTimeout(() => void poll(read.sourceId, read.cursor), POLL_MS);
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: "disconnected",
          message: error instanceof Error ? error.message : "The log could not be read.",
        });
      }
    };

    void (async () => {
      try {
        const opened = await backend.openContainerLogs(containerId);
        if (cancelled) {
          void backend.closeContainerLogs(opened.subscriptionId).catch(() => undefined);
          return;
        }
        subscriptionId = opened.subscriptionId;
        await poll(opened.sourceId, opened.cursor);
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: "disconnected",
            message: error instanceof Error ? error.message : "The log could not be opened.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // Releases the observer only; the container keeps running.
      if (subscriptionId) void backend.closeContainerLogs(subscriptionId).catch(() => undefined);
    };
  }, [append, containerId, generation]);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span role="status">
          {state.kind === "connecting"
            ? "Connecting…"
            : state.kind === "following"
              ? "Following"
              : state.kind === "ended"
                ? "The container stopped; its log ended here."
                : `Disconnected: ${state.message}`}
        </span>
        {state.kind === "ended" || state.kind === "disconnected" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setGeneration((value) => value + 1)}
          >
            Follow again
          </Button>
        ) : null}
      </div>
      {gaps > 0 ? (
        <p className="text-xs text-yellow-700 dark:text-yellow-400">
          Some output was produced faster than it was kept; only the most recent part is shown.
        </p>
      ) : null}
      <pre
        ref={scroller}
        aria-label="Container log"
        className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs"
      >
        {lines.length > 0 ? lines.join("") : state.kind === "following" ? "No output yet." : ""}
      </pre>
    </div>
  );
}
