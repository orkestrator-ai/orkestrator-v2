/**
 * Display-side coalescing for a streaming text part.
 *
 * Provider events are never dropped or delayed upstream: this only decides
 * how often one text part re-parses its Markdown. Appends commit through at
 * most one scheduled animation frame and no more than
 * `MARKDOWN_POLICY.maxStreamingUpdatesPerSecond` times a second; the latest
 * content always lands (a trailing commit is the final flush). Anything that
 * is not a pure append — a replaced or edited message — commits immediately.
 *
 * `live` is a display hint: the part changed within the last idle window. It
 * keeps streaming-only affordances (like Run in terminal) disabled while text
 * is still arriving; it never decides whether a fence is complete.
 */
import { useEffect, useRef, useState } from "react";
import { MARKDOWN_POLICY } from "@orkestrator/protocol/rich-content-policy";

export const STREAMING_MIN_INTERVAL_MS = 1000 / MARKDOWN_POLICY.maxStreamingUpdatesPerSecond;
export const STREAMING_IDLE_MS = 1_500;

export interface CoalescerScheduler {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  requestFrame: (callback: () => void) => unknown;
  cancelFrame: (handle: unknown) => void;
}

const browserScheduler: CoalescerScheduler = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  requestFrame: (callback) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(callback)
      : setTimeout(callback, 16),
  cancelFrame: (handle) => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle as number);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Pure coalescing state machine, separated from React so its rate and
 * final-flush guarantees can be tested with a fake clock.
 */
export class StreamingTextCoalescer {
  private latest: string;
  private committed: string;
  private lastCommitAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private frame: unknown = null;
  private idleTimer: unknown = null;
  live = false;

  constructor(
    initial: string,
    private readonly onCommit: (text: string, live: boolean) => void,
    private readonly scheduler: CoalescerScheduler = browserScheduler,
    private readonly minIntervalMs = STREAMING_MIN_INTERVAL_MS,
  ) {
    this.latest = initial;
    this.committed = initial;
  }

  /** Feed the latest content. Returns true when it was committed synchronously. */
  push(content: string): boolean {
    this.latest = content;
    if (content === this.committed) return false;
    if (!content.startsWith(this.committed)) {
      // Not an append: show the new text now rather than a stale prefix.
      this.cancelPending();
      this.commit(false);
      return true;
    }
    if (this.timer !== null || this.frame !== null) return false;
    const wait = Math.max(0, this.lastCommitAt + this.minIntervalMs - this.scheduler.now());
    const toFrame = () => {
      this.timer = null;
      this.frame = this.scheduler.requestFrame(() => {
        this.frame = null;
        this.commit(true);
      });
    };
    if (wait > 0) this.timer = this.scheduler.setTimeout(toFrame, wait);
    else toFrame();
    return false;
  }

  private commit(live: boolean): void {
    this.committed = this.latest;
    this.lastCommitAt = this.scheduler.now();
    if (live) {
      this.live = true;
      if (this.idleTimer !== null) this.scheduler.clearTimeout(this.idleTimer);
      this.idleTimer = this.scheduler.setTimeout(() => {
        this.idleTimer = null;
        this.live = false;
        this.onCommit(this.committed, false);
      }, STREAMING_IDLE_MS);
    }
    this.onCommit(this.committed, this.live);
  }

  private cancelPending(): void {
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    if (this.frame !== null) this.scheduler.cancelFrame(this.frame);
    this.timer = null;
    this.frame = null;
  }

  dispose(): void {
    this.cancelPending();
    if (this.idleTimer !== null) this.scheduler.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** The coalesced display text of one streaming part, plus its `live` hint. */
export function useStreamingDisplayText(content: string): { text: string; live: boolean } {
  const [state, setState] = useState(() => ({ text: content, live: false }));
  const coalescer = useRef<StreamingTextCoalescer | null>(null);

  const committedText = state.text;
  useEffect(() => {
    coalescer.current ??= new StreamingTextCoalescer(committedText, (text, live) =>
      setState({ text, live }),
    );
    // Idempotent: re-pushing the same content schedules nothing new.
    coalescer.current.push(content);
  }, [content, committedText]);

  useEffect(
    () => () => {
      coalescer.current?.dispose();
      coalescer.current = null;
    },
    [],
  );

  // A non-append change renders immediately on this pass, not a frame later.
  if (!content.startsWith(state.text)) return { text: content, live: false };
  return state;
}
