import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NavigationOwner } from "@/lib/transcript-scroll/scroll-intent";
import type { SemanticAnchor } from "@/lib/transcript-scroll/transcript-scroll-controller";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { sourceIndexOf, toScrollAnchor } from "./useHeldTranscriptPlace";
import type { TranscriptScrollAnchor } from "./useVirtuosoScrollState";

/** History pages that bring rows, but not the reader's, before the place is given up. */
export const HISTORY_DROP_RESTORE_MAX_PAGES = 8;
/**
 * Pages that bring nothing in front, retried this far apart. Right after a
 * bridge restart the bridge is still re-reading its rollout, and a page cut
 * from the epoch before that read lands comes back empty.
 */
export const HISTORY_DROP_RESTORE_RETRY_MS = 750;
/** Empty pages before the place is given up: about nine seconds of retries. */
export const HISTORY_DROP_RESTORE_MAX_EMPTY_PAGES = 12;

/** The parts of the transcript's scroll controller this reads. */
export interface ReaderPlaceSource {
  readonly wantsFollow: boolean;
  /** The reader's place as of their last settled scroll; null while following. */
  readonly readingAnchor: SemanticAnchor | null;
}

export interface RestorePlaceAfterHistoryDropInput {
  sessionKey: string;
  /** The rendered display rows. */
  messages: readonly NativeMessage[];
  controller: ReaderPlaceSource;
  /** A history page (any) is in flight. */
  loading: boolean;
  canLoadEarlier: boolean;
  /** Load one history page; the caller owns `loading`. */
  loadEarlier: () => Promise<unknown>;
  scrollToIndex: (
    index: number,
    anchor?: TranscriptScrollAnchor,
    owner?: NavigationOwner,
  ) => unknown;
}

interface Restoration {
  sessionKey: string;
  /** The source part (a tool call id, or a source part id) the reader was on. */
  target: string;
  anchor: SemanticAnchor;
  /** Pages that moved the transcript's head, and pages that did not. */
  pages: number;
  emptyPages: number;
  /** The head when the last page was requested; undefined before the first. */
  lastRequest?: { headId: string | undefined; settled: boolean; counted: boolean };
}

/**
 * Brings a reader back to their place when the history they were reading
 * drops off the transcript under them.
 *
 * A tab keeps the history pages it loaded only while the live tail still joins
 * them. A bridge restart is a new history epoch, and the first replay after
 * live streaming renames every Codex row (`replayedRowId`), so the tab falls
 * back to the bare live tail: the safe answer, since it cannot tell a replay
 * from a rewritten history. A reader who was in those pages was left wherever
 * the shorter list put them. Tool calls keep their ids across a replay, so the
 * reader's source part can be found again: this pages history back in until it
 * reappears and scrolls to it at its old offset. A part that never comes back
 * (a history that really was rewritten) gives up after
 * {@link HISTORY_DROP_RESTORE_MAX_PAGES} pages, or when history runs out,
 * and leaves the list where it is.
 *
 * Returns whether a restoration is under way, so automatic paging can stand
 * aside rather than hold a place of its own.
 */
export function useRestorePlaceAfterHistoryDrop({
  sessionKey,
  messages,
  controller,
  loading,
  canLoadEarlier,
  loadEarlier,
  scrollToIndex,
}: RestorePlaceAfterHistoryDropInput): boolean {
  const previousRef = useRef<{ sessionKey: string; messages: readonly NativeMessage[] } | null>(
    null,
  );
  const restorationRef = useRef<Restoration | null>(null);
  /** The last part restored: a part that drops again is not chased twice. */
  const restoredRef = useRef<string | undefined>(undefined);
  const [restoring, setRestoring] = useState<Restoration | null>(null);
  /** Bumped as each page settles, so the next step runs whatever order React renders in. */
  const [settledPages, setSettledPages] = useState(0);

  const track = (restoration: Restoration | null) => {
    restorationRef.current = restoration;
    setRestoring(restoration);
  };
  const finish = () => track(null);

  // Before paint, while the reader's settled anchor still describes the rows
  // that were on screen (it is recaptured only once scrolling goes idle).
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { sessionKey, messages };
    const restoration = restorationRef.current;
    if (restoration) {
      if (restoration.sessionKey !== sessionKey) {
        finish();
        return;
      }
      const found = sourceIndexOf(messages).part.get(restoration.target);
      if (found === undefined) return;
      finish();
      restoredRef.current = restoration.target;
      // A reader who chose to follow the latest message meanwhile keeps that.
      if (controller.wantsFollow) return;
      scrollToIndex(
        found,
        { ...toScrollAnchor(restoration.anchor), rowKey: messages[found]!.id },
        "history",
      );
      return;
    }
    if (
      !previous ||
      previous.sessionKey !== sessionKey ||
      previous.messages === messages ||
      // History only drops from the front: an unchanged head dropped nothing.
      previous.messages[0]?.id === messages[0]?.id ||
      controller.wantsFollow
    ) {
      return;
    }
    const anchor = controller.readingAnchor;
    const target = anchor?.inner?.partId ?? anchor?.partId;
    if (!anchor || !target || target === restoredRef.current) return;
    if (!sourceIndexOf(previous.messages).part.has(target)) return;
    if (sourceIndexOf(messages).part.has(target)) return;
    // The drop is observed in the scroll controller and the committed rows, both
    // outside render; the state mirrors it for the paging effect and caller.
    // oxlint-disable-next-line react/set-state-in-effect
    track({ sessionKey, target, anchor, pages: 0, emptyPages: 0 });
  }, [controller, messages, scrollToIndex, sessionKey]);

  // One page at a time, until the part is back or there is nothing left to page.
  // The head is read from the last commit rather than depended on, so a poll
  // landing while an empty page waits to be retried does not restart its wait.
  useEffect(() => {
    const restoration = restorationRef.current;
    if (!restoring || restoration !== restoring || loading) return;
    const last = restoration.lastRequest;
    if (last && !last.settled) return;
    const empty = last !== undefined && last.headId === previousRef.current?.messages[0]?.id;
    if (last && !last.counted) {
      last.counted = true;
      if (empty) restoration.emptyPages += 1;
      else restoration.pages += 1;
    }
    if (
      restoration.sessionKey !== sessionKey ||
      !canLoadEarlier ||
      restoration.pages >= HISTORY_DROP_RESTORE_MAX_PAGES ||
      restoration.emptyPages >= HISTORY_DROP_RESTORE_MAX_EMPTY_PAGES
    ) {
      finish();
      return;
    }
    const request = () => {
      const page = {
        headId: previousRef.current?.messages[0]?.id,
        settled: false,
        counted: false,
      };
      restoration.lastRequest = page;
      void loadEarlier()
        .catch(() => {
          if (restorationRef.current === restoration) finish();
        })
        .finally(() => {
          page.settled = true;
          setSettledPages((count) => count + 1);
        });
    };
    if (!empty) {
      request();
      return;
    }
    const timer = setTimeout(request, HISTORY_DROP_RESTORE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [canLoadEarlier, loadEarlier, loading, restoring, sessionKey, settledPages]);

  return restoring !== null;
}
